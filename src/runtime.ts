import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Role, State, TaskRecord } from "./types.ts";
import { terminal } from "./types.ts";
import { TaskStore } from "./store.ts";

export const MAX_CONCURRENCY = 4;
const START_GRACE_MS = 10_000;

function active(status: TaskRecord["status"]): boolean {
	return status === "starting" || status === "running" || status === "finishing";
}

export function pidAlive(pid?: number): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function processGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}

export async function killProcessTree(pid?: number): Promise<void> {
	if (!pid) return;
	if (process.platform === "win32") {
		const exitCode = await new Promise<number | null>((resolve, reject) => {
			const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
			child.once("error", reject);
			child.once("close", resolve);
		});
		if (exitCode !== 0 && pidAlive(pid)) throw new Error(`failed to terminate subagent process tree ${pid}`);
		return;
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	await new Promise((resolve) => setTimeout(resolve, 300));
	if (processGroupAlive(pid)) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
	}
	const deadline = Date.now() + 2_000;
	while (processGroupAlive(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	if (processGroupAlive(pid)) throw new Error(`subagent process tree ${pid} did not terminate`);
}

type SpawnRunner = (executable: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

export class Runtime {
	readonly store: TaskStore;
	readonly runner: string;
	private readonly spawnRunner: SpawnRunner;

	constructor(
		store: TaskStore,
		runner = fileURLToPath(new URL("./runner.ts", import.meta.url)),
		spawnRunner: SpawnRunner = spawn,
	) {
		this.store = store;
		this.runner = runner;
		this.spawnRunner = spawnRunner;
	}

	launch(
		role: Role,
		task: string,
		cwd: string,
		parentSessionId: string,
		notifyOn?: string,
		inherited?: { model?: string; thinking?: string },
	): TaskRecord {
		const created = this.store.lock("queue", () => {
			const activeCount = this.store.list().filter((candidate) => active(candidate.status)).length;
			const status = activeCount >= MAX_CONCURRENCY ? "queued" as const : "starting" as const;
			for (let attempt = 0; attempt < 5; attempt++) {
				const id = `sa_${randomBytes(10).toString("hex")}`;
				const createdAt = Date.now();
				try {
					this.store.create({
						id,
						parentSessionId,
						role: role.name,
						roleSource: role.source,
						roleBody: role.body,
						task,
						cwd,
						createdAt,
						model: role.model ?? inherited?.model,
						thinking: role.thinking ?? inherited?.thinking,
						maxTurns: role.maxTurns,
						tools: role.tools.filter((tool) => tool !== "subagent"),
						notifyOn,
					}, { status, updatedAt: createdAt, turn: 0, activity: [] });
					return this.store.get(id);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 4) throw error;
				}
			}
			throw new Error("could not allocate a subagent taskId");
		});
		if (created.status === "starting") this.spawn(created.id);
		return this.store.get(created.id);
	}

	spawn(id: string): void {
		const task = this.store.get(id);
		try {
			const child = this.spawnRunner(process.execPath, ["--experimental-strip-types", this.runner, this.store.dir, id], {
				cwd: task.cwd,
				detached: true,
				stdio: "ignore",
				env: { ...process.env, PI_SUBAGENT_CHILD: "1" },
			});
			child.once("error", (error) => this.failStart(id, error));
			child.unref();
		} catch (error) {
			this.failStart(id, error);
		}
	}

	pumpQueue(): void {
		this.reconcileDead(this.store.list());
		const promoted = this.store.lock("queue", () => {
			let slots = MAX_CONCURRENCY - this.store.list().filter((task) => active(task.status)).length;
			const ids: string[] = [];
			for (const task of this.store.list().filter((candidate) => candidate.status === "queued").sort((a, b) => a.createdAt - b.createdAt)) {
				if (slots-- <= 0) break;
				const state = this.store.state(task);
				state.status = "starting";
				this.store.saveState(task.id, state);
				ids.push(task.id);
			}
			return ids;
		});
		for (const id of promoted) this.spawn(id);
	}

	message(id: string, sessionId: string, text: string): { task: TaskRecord; queuedAt: number } {
		const task = this.store.assertOwner(id, sessionId);
		if (terminal(task.status) || task.status === "finishing") {
			throw new Error(`subagent task ${id} is no longer accepting messages`);
		}
		const control = this.store.controlIfActive(id, "message", text);
		return { task: this.store.get(id), queuedAt: control.at };
	}

	async stop(id: string, sessionId: string): Promise<TaskRecord> {
		let task = this.store.assertOwner(id, sessionId);
		if (terminal(task.status)) return task;
		this.store.marker(id, "stop.requested");

		if (task.status === "queued") {
			const state = this.store.state(task);
			state.status = "cancelled";
			state.endedAt = Date.now();
			this.store.saveState(id, state);
			this.store.event(id, "terminal", { status: "cancelled", at: Date.now() });
			this.pumpQueue();
			return this.store.get(id);
		}

		const targetPid = task.pid;
		this.store.control(id, "stop");
		task = await this.wait(id, sessionId, 2, false);
		await killProcessTree(targetPid);
		if (!terminal(task.status)) {
			task = this.store.assertOwner(id, sessionId);
			if (!terminal(task.status)) {
				const state = this.store.state(task);
				state.status = "cancelled";
				state.endedAt = Date.now();
				this.store.saveState(id, state);
				this.store.event(id, "terminal", { status: "cancelled", at: Date.now() });
			}
		}
		this.pumpQueue();
		return this.store.get(id);
	}

	reconcile(sessionId: string): void {
		this.reconcileDead(this.store.list().filter((task) => task.parentSessionId === sessionId));
		this.pumpQueue();
	}

	async wait(id: string, sessionId: string, seconds: number, readiness = false, signal?: AbortSignal): Promise<TaskRecord> {
		signal?.throwIfAborted();
		const deadline = Date.now() + seconds * 1000;
		while (true) {
			const task = this.store.assertOwner(id, sessionId);
			if (terminal(task.status) || (readiness && task.ready) || Date.now() >= deadline) return task;
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					cleanup();
					resolve();
				};
				const abort = () => {
					cleanup();
					reject(signal?.reason ?? new Error("aborted"));
				};
				const cleanup = () => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
				};
				const timer = setTimeout(done, Math.min(100, Math.max(0, deadline - Date.now())));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		}
	}

	private failStart(id: string, error: unknown): void {
		try {
			const task = this.store.get(id);
			if (terminal(task.status)) return;
			const state = this.store.state(task);
			state.status = "failed";
			state.error = error instanceof Error ? error.message : String(error);
			state.endedAt = Date.now();
			this.store.saveState(id, state);
			this.store.event(id, "terminal", { status: "failed", at: Date.now() });
			this.pumpQueue();
		} catch {
			// A detached runner or another reconciler may already own the final state.
		}
	}

	private reconcileDead(tasks: TaskRecord[]): void {
		for (const task of tasks) {
			if (!active(task.status)) continue;
			if (task.status === "starting" && !task.pid && Date.now() - task.createdAt < START_GRACE_MS) continue;
			if (pidAlive(task.pid)) continue;
			const current = this.store.get(task.id);
			if (terminal(current.status) || pidAlive(current.pid)) continue;
			const state: State = this.store.state(current);
			state.status = this.store.has(task.id, "stop.requested") ? "cancelled" : "orphaned";
			state.error = state.status === "orphaned" ? "Detached runner exited without a terminal state" : undefined;
			state.endedAt = Date.now();
			this.store.saveState(task.id, state);
			this.store.event(task.id, "terminal", { status: state.status, at: Date.now() });
		}
	}
}
