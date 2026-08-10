import {
	chmodSync,
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { ClaimedControl, Control, Launch, Snapshot, State, TaskRecord } from "./types.ts";
import { terminal } from "./types.ts";

const ID = /^sa_[a-f0-9]{20}$/;
const EVENT_NAME = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class TaskStore {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	}

	taskDir(id: string): string {
		if (!ID.test(id)) throw new Error(`invalid taskId ${JSON.stringify(id)}`);
		return join(this.dir, id);
	}

	private read<T>(path: string): T {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	}

	private atomic(path: string, value: unknown): void {
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
	}

	private atomicCreate(path: string, value: unknown): boolean {
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
			linkSync(temporary, path);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			return false;
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	create(launch: Launch, state: State): void {
		const directory = this.taskDir(launch.id);
		mkdirSync(directory, { mode: 0o700 });
		mkdirSync(join(directory, "controls"), { mode: 0o700 });
		mkdirSync(join(directory, "events"), { mode: 0o700 });
		this.atomic(join(directory, "launch.json"), launch);
		this.atomic(join(directory, "state.json"), this.boundedState(state));
	}

	get(id: string): TaskRecord {
		const directory = this.taskDir(id);
		try {
			const launch = this.read<Launch>(join(directory, "launch.json"));
			const state = this.read<State>(join(directory, "state.json"));
			if (launch.id !== id || !Array.isArray(state.activity)) throw new Error("invalid record");
			return { ...launch, ...state };
		} catch {
			if (existsSync(directory)) throw new Error(`taskId ${id} is corrupt or unreadable; diagnosticsPath: ${directory}`);
			throw new Error(`unknown taskId ${id}`);
		}
	}

	saveState(id: string, next: State): State {
		return this.lock(`state-${id}`, () => {
			const current = this.read<State>(join(this.taskDir(id), "state.json"));
			if (terminal(current.status)) return current;
			const bounded = this.boundedState({ ...next, updatedAt: Date.now() });
			this.atomic(join(this.taskDir(id), "state.json"), bounded);
			return bounded;
		});
	}

	state(task: TaskRecord): State {
		const { status, updatedAt, startedAt, endedAt, pid, ready, result, error, failureKind, turn, tokens, messageAcceptedAt, activity } = task;
		return { status, updatedAt, startedAt, endedAt, pid, ready, result, error, failureKind, turn, tokens, messageAcceptedAt, activity };
	}

	list(): TaskRecord[] {
		return readdirSync(this.dir)
			.filter((entry) => ID.test(entry))
			.flatMap((entry) => {
				try {
					return [this.get(entry)];
				} catch {
					return [];
				}
			});
	}

	assertOwner(id: string, sessionId: string): TaskRecord {
		const task = this.get(id);
		if (task.parentSessionId !== sessionId) throw new Error(`taskId ${id} belongs to another session`);
		return task;
	}

	control(id: string, kind: Control["kind"], text?: string): Control {
		const control = {
			seq: `${Date.now().toString().padStart(13, "0")}-${randomUUID()}`,
			kind,
			text,
			at: Date.now(),
		} satisfies Control;
		this.atomicCreate(join(this.taskDir(id), "controls", `${control.seq}.json`), control);
		return control;
	}

	controlIfActive(id: string, kind: Control["kind"], text?: string): Control {
		return this.lock(`state-${id}`, () => {
			const state = this.read<State>(join(this.taskDir(id), "state.json"));
			if (terminal(state.status) || state.status === "finishing") {
				throw new Error(`subagent task ${id} is no longer accepting messages`);
			}
			return this.control(id, kind, text);
		});
	}

	beginFinishing(id: string, allowPendingControls = false): State {
		return this.lock(`state-${id}`, () => {
			const current = this.read<State>(join(this.taskDir(id), "state.json"));
			if (terminal(current.status) || current.status === "finishing") return current;
			if (!allowPendingControls && this.controlFiles(id).length > 0) return current;
			const next = this.boundedState({ ...current, status: "finishing", updatedAt: Date.now() });
			this.atomic(join(this.taskDir(id), "state.json"), next);
			return next;
		});
	}

	controlFiles(id: string): string[] {
		return readdirSync(join(this.taskDir(id), "controls")).filter((entry) => entry.endsWith(".json")).sort();
	}

	claimControl(id: string, file: string): ClaimedControl | undefined {
		const originalPath = join(this.taskDir(id), "controls", basename(file));
		const path = `${originalPath}.claimed-${process.pid}`;
		try {
			renameSync(originalPath, path);
			return { path, originalPath, value: this.read<Control>(path) };
		} catch {
			return undefined;
		}
	}

	finishControl(control: ClaimedControl): void {
		rmSync(control.path, { force: true });
	}

	releaseControl(control: ClaimedControl): void {
		try {
			renameSync(control.path, control.originalPath);
		} catch {
			// A later retry or terminal reconciliation will handle a lost claimant.
		}
	}

	lock<T>(name: string, operation: () => T): T {
		const path = join(this.dir, `.${name}.lock`);
		let descriptor: number | undefined;
		for (let attempt = 0; attempt < 100; attempt++) {
			try {
				descriptor = openSync(path, "wx", 0o600);
				writeFileSync(descriptor, JSON.stringify({ pid: process.pid, at: Date.now() }));
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const owner = this.read<{ pid: number; at: number }>(path);
					if ((!pidAlive(owner.pid) && Date.now() - owner.at > 1000) || Date.now() - owner.at > 60000) {
						unlinkSync(path);
						continue;
					}
				} catch {
					// The lock holder may still be writing the small ownership record.
				}
				Atomics.wait(LOCK_WAIT, 0, 0, 10);
			}
		}
		if (descriptor === undefined) throw new Error(`task store lock ${name} is busy`);
		try {
			return operation();
		} finally {
			closeSync(descriptor);
			rmSync(path, { force: true });
		}
	}

	event(id: string, name: string, data: unknown): boolean {
		this.assertEventName(name);
		return this.atomicCreate(join(this.taskDir(id), "events", `${name}.json`), data);
	}

	marker(id: string, name: string): boolean {
		this.assertEventName(name);
		return this.atomicCreate(join(this.taskDir(id), "events", name), "");
	}

	removeMarker(id: string, name: string): void {
		this.assertEventName(name);
		rmSync(join(this.taskDir(id), "events", name), { force: true });
	}

	has(id: string, name: string): boolean {
		this.assertEventName(name);
		return existsSync(join(this.taskDir(id), "events", name));
	}

	claimNotification(id: string, event: "ready" | "terminal", leaseMs = 30_000): boolean {
		return this.lock(`notify-${id}-${event}`, () => {
			const delivered = `${event}.notified`;
			const submitted = `${event}.submitted`;
			const lease = `${event}.notifying`;
			if (this.has(id, delivered)) return false;
			if (this.has(id, submitted)) {
				try {
					const age = Date.now() - statSync(join(this.taskDir(id), "events", submitted)).mtimeMs;
					if (age <= leaseMs) return false;
				} catch {
					return false;
				}
				this.removeMarker(id, submitted);
			}
			if (this.has(id, lease)) {
				try {
					const age = Date.now() - statSync(join(this.taskDir(id), "events", lease)).mtimeMs;
					if (age <= leaseMs) return false;
				} catch {
					return false;
				}
				this.removeMarker(id, lease);
			}
			return this.marker(id, lease);
		});
	}

	submitNotification(id: string, event: "ready" | "terminal"): void {
		this.lock(`notify-${id}-${event}`, () => {
			const submitted = `${event}.submitted`;
			const lease = `${event}.notifying`;
			if (this.has(id, `${event}.notified`)) {
				this.removeMarker(id, lease);
				return;
			}
			if (this.has(id, submitted)) {
				const path = join(this.taskDir(id), "events", submitted);
				const now = new Date();
				utimesSync(path, now, now);
				this.removeMarker(id, lease);
				return;
			}
			if (this.has(id, lease)) {
					const path = join(this.taskDir(id), "events", submitted);
					renameSync(join(this.taskDir(id), "events", lease), path);
					const now = new Date();
					utimesSync(path, now, now);
				}
		});
	}

	completeNotification(id: string, event: "ready" | "terminal"): void {
		this.lock(`notify-${id}-${event}`, () => {
			if (!this.has(id, `${event}.notified`)) this.marker(id, `${event}.notified`);
			this.removeMarker(id, `${event}.notifying`);
			this.removeMarker(id, `${event}.submitted`);
		});
	}

	withdrawNotification(
		id: string,
		event: "ready" | "terminal",
		reason: "presented" | "superseded" | "retry-exhausted",
	): void {
		this.lock(`notify-${id}-${event}`, () => {
			if (reason === "superseded") {
				if (!this.has(id, `${event}.notified`)) this.marker(id, `${event}.notified`);
				this.removeMarker(id, `${event}.notifying`);
				this.removeMarker(id, `${event}.submitted`);
				return;
			}
			if (reason === "retry-exhausted") {
				this.removeMarker(id, `${event}.submitted`);
				if (!this.has(id, `${event}.notifying`)) this.marker(id, `${event}.notifying`);
				const path = join(this.taskDir(id), "events", `${event}.notifying`);
				const now = new Date();
				utimesSync(path, now, now);
				return;
			}
			this.removeMarker(id, `${event}.notifying`);
			this.removeMarker(id, `${event}.submitted`);
		});
	}

	releaseNotification(id: string, event: "ready" | "terminal"): void {
		this.removeMarker(id, `${event}.notifying`);
	}

	snapshot(task: TaskRecord): Snapshot {
		const isTerminal = terminal(task.status);
		const activity = isTerminal ? undefined : task.activity.slice(-3).map(({ kind, text }) => ({ kind, text }));
		return {
			taskId: task.id,
			status: task.status,
			role: task.role,
			ready: !isTerminal && task.ready ? true : undefined,
			result: task.result?.slice(0, 12000),
			error: task.error,
			messageAcceptedAt: task.messageAcceptedAt,
			activity: activity && activity.length > 0 ? activity : undefined,
			diagnosticsPath: task.failureKind === "infrastructure" ? this.taskDir(task.id) : undefined,
		};
	}

	cleanup(ttl = 7 * 864e5, max = 200): void {
		const completed = this.list().filter((task) => task.endedAt).sort((a, b) => b.endedAt! - a.endedAt!);
		completed.forEach((task, index) => {
			if (Date.now() - task.endedAt! > ttl || index >= max) {
				rmSync(this.taskDir(task.id), { recursive: true, force: true });
			}
		});
	}

	private boundedState(state: State): State {
		return {
			...state,
			activity: state.activity.slice(-40),
			result: state.result?.slice(0, 65536),
			error: state.error?.slice(0, 4096),
		};
	}

	private assertEventName(name: string): void {
		if (!EVENT_NAME.test(name)) throw new Error(`invalid event name ${JSON.stringify(name)}`);
	}
}
