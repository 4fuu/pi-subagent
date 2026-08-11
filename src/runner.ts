import { appendFileSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Runtime } from "./runtime.ts";
import { TaskStore } from "./store.ts";
import type { State } from "./types.ts";
import { terminal } from "./types.ts";

const RUNTIME_CONTRACT = `You are a child agent with fresh context, sharing the parent's working directory and inherited environment. Follow the role and task, stay in scope, use only provided tools, and do not delegate. Return a concise, self-contained result with evidence, checks, and limitations; verify consequential claims.`;
const MAX_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024;

export function reachedTurnLimit(turn: number, max?: number): boolean {
	return max !== undefined && turn >= max;
}

export function turnLimitWouldTruncate(turn: number, max: number | undefined, hasToolCalls: boolean, hasPendingSteer: boolean): boolean {
	return reachedTurnLimit(turn, max) && (hasToolCalls || hasPendingSteer);
}

export function steeringAllowed(turn: number, max: number, streaming: boolean): boolean {
	return streaming && !reachedTurnLimit(turn, max);
}

export type ActivityMerge = "append" | "delta" | "replace";

export function mergeActivityText(previous: string | undefined, value: string, merge: ActivityMerge): string {
	const normalized = value.replace(/\s+/g, " ");
	if (merge === "delta") {
		return `${previous ?? ""}${previous === undefined ? normalized.trimStart() : normalized}`.slice(-500);
	}
	const clean = normalized.trim();
	if (!clean) return previous ?? "";
	if (merge === "replace" || previous === undefined) return clean.slice(-500);
	return `${previous} ${clean}`.slice(-500);
}

export class LiteralMatcher {
	private carry = "";
	private readonly needle?: string;

	constructor(needle?: string) {
		this.needle = needle;
	}

	reset(): void {
		this.carry = "";
	}

	feed(text: string): boolean {
		if (!this.needle || !text) return false;
		const value = this.carry + text;
		const found = value.includes(this.needle);
		this.carry = value.slice(-Math.max(0, this.needle.length - 1));
		return found;
	}
}

function textualContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((entry): entry is { type: "text"; text: string } => {
			return typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "text"
				&& typeof (entry as { text?: unknown }).text === "string";
		})
		.map((entry) => entry.text)
		.join("\n");
}

export async function run(storeDir: string, id: string): Promise<void> {
	const store = new TaskStore(storeDir);
	const launch = store.get(id);
	let state: State = store.state(launch);
	let pollTimer: NodeJS.Timeout | undefined;
	let activityTimer: NodeJS.Timeout | undefined;
	let unsubscribe: (() => void) | undefined;
	let session: AgentSession | undefined;
	let polling = false;
	let turnLimitReached = false;
	let steeringPending = false;
	const matcher = new LiteralMatcher(launch.notifyOn);
	const transcriptPath = join(store.taskDir(id), "transcript.jsonl");
	let transcriptBytes = (() => {
		try {
			return statSync(transcriptPath).size;
		} catch {
			return 0;
		}
	})();

	const save = (): void => {
		state = store.saveState(id, state);
	};
	const flushActivity = (): void => {
		if (activityTimer) clearTimeout(activityTimer);
		activityTimer = undefined;
		if (!terminal(state.status)) save();
	};
	const activity = (kind: string, value: string, merge: ActivityMerge = "append"): void => {
		if (!value || terminal(state.status)) return;
		const now = Date.now();
		const last = state.activity.at(-1);
		if (last?.kind === kind && now - last.at < 1000) {
			const text = mergeActivityText(last.text, value, merge);
			if (!text.trim()) return;
			last.at = now;
			last.text = text;
		} else {
			const text = mergeActivityText(undefined, value, merge);
			if (!text.trim()) return;
			state.activity.push({ at: now, kind, text });
		}
		if (!activityTimer) {
			activityTimer = setTimeout(flushActivity, 100);
			activityTimer.unref?.();
		}
	};
	const appendTranscript = (kind: "assistant" | "tool-result", value: string): void => {
		let line = Buffer.from(`${JSON.stringify({ at: Date.now(), kind, text: value })}\n`, "utf8");
		if (line.length > TRANSCRIPT_TAIL_BYTES) {
			const boundedText = Buffer.from(value, "utf8").subarray(-Math.floor(TRANSCRIPT_TAIL_BYTES / 2)).toString("utf8");
			line = Buffer.from(`${JSON.stringify({ at: Date.now(), kind, text: boundedText, truncated: true })}\n`, "utf8");
		}
		if (transcriptBytes + line.length > MAX_TRANSCRIPT_BYTES) {
			let tail = readFileSync(transcriptPath).subarray(-TRANSCRIPT_TAIL_BYTES);
			const newline = tail.indexOf(0x0a);
			if (newline >= 0) tail = tail.subarray(newline + 1);
			writeFileSync(transcriptPath, tail, { mode: 0o600 });
			transcriptBytes = tail.length;
		}
		appendFileSync(transcriptPath, line, { mode: 0o600 });
		transcriptBytes += line.length;
	};
	const visible = (kind: "assistant" | "tool-result", value: string, merge: ActivityMerge = "append"): void => {
		if (!value) return;
		appendTranscript(kind, value);
		activity(kind, value, merge);
		if (!state.ready && matcher.feed(value)) {
			flushActivity();
			state.ready = true;
			save();
			store.event(id, "ready", { at: Date.now() });
		}
	};

	const pollControls = async (): Promise<void> => {
		if (polling || !session || terminal(state.status)) return;
		polling = true;
		try {
			for (const file of store.controlFiles(id)) {
				const control = store.claimControl(id, file);
				if (!control) continue;
				try {
					if (control.value.kind === "stop") {
						flushActivity();
						await session.abort();
						state = store.beginFinishing(id, true);
						state.status = "cancelled";
						state.endedAt = Date.now();
						save();
						store.finishControl(control);
						break;
					}
					if (!steeringAllowed(state.turn, launch.maxTurns, session.isStreaming)) {
						store.releaseControl(control);
						break;
					}
					await session.steer(control.value.text ?? "");
					steeringPending = true;
					activity("steer", control.value.text ?? "");
					flushActivity();
					state.messageAcceptedAt = Date.now();
					save();
					store.finishControl(control);
				} catch (error) {
					store.releaseControl(control);
					activity("control-error", error instanceof Error ? error.message : String(error));
				}
			}
		} finally {
			polling = false;
		}
	};

	try {
		if (terminal(state.status) || store.has(id, "stop.requested")) {
			if (!terminal(state.status)) {
				state.status = "cancelled";
				state.endedAt = Date.now();
				save();
			}
			return;
		}
		state.status = "running";
		state.pid = process.pid;
		state.startedAt ??= Date.now();
		save();

		const loader = new DefaultResourceLoader({
			cwd: launch.cwd,
			agentDir: getAgentDir(),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPromptOverride: () => `${launch.roleBody}\n\n${RUNTIME_CONTRACT}`,
		});
		await loader.reload();
		const modelRuntime = await ModelRuntime.create();
		let model;
		if (launch.model) {
			const [provider, ...modelId] = launch.model.split("/");
			model = modelRuntime.getModel(provider!, modelId.join("/"));
			if (!model) throw new Error(`unknown model ${launch.model}`);
		}
		({ session } = await createAgentSession({
			cwd: launch.cwd,
			modelRuntime,
			model,
			thinkingLevel: launch.thinking as never,
			tools: launch.tools,
			excludeTools: ["subagent"],
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(launch.cwd),
		}));
		const activeTools = new Set(session.getActiveToolNames());
		const missingTools = launch.tools.filter((tool) => !activeTools.has(tool));
		if (missingTools.length > 0) throw new Error(`role requests unavailable tools: ${missingTools.join(", ")}`);

		session.agent.shouldStopAfterTurn = ({ message }) => {
			if (!reachedTurnLimit(state.turn, launch.maxTurns)) return false;
			const hasToolCalls = message.content.some((entry) => entry.type === "toolCall");
			turnLimitReached ||= turnLimitWouldTruncate(state.turn, launch.maxTurns, hasToolCalls, steeringPending);
			return true;
		};
		unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "message_start" && event.message.role === "assistant") matcher.reset();
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				visible("assistant", event.assistantMessageEvent.delta, "delta");
			}
			if (event.type === "tool_execution_start") {
				const path = typeof event.args?.path === "string" ? ` ${event.args.path}` : "";
				activity("tool", `${event.toolName}${path}`);
			}
			if (event.type === "tool_execution_update") {
				activity("tool-progress", textualContent(event.partialResult?.content), "replace");
			}
			if (event.type === "tool_execution_end") {
				matcher.reset();
				visible("tool-result", textualContent(event.result?.content));
				matcher.reset();
			}
			if (event.type === "turn_start") {
				flushActivity();
				if (state.turn > 0) steeringPending = false;
				state.turn++;
				save();
			}
			if (event.type === "turn_end" && event.message.role === "assistant") {
				const usage = event.message.usage as { totalTokens?: number } | undefined;
				if (typeof usage?.totalTokens === "number") state.tokens = (state.tokens ?? 0) + usage.totalTokens;
			}
		});
		let nextPrompt: string | undefined = launch.task;
		while (nextPrompt !== undefined) {
			pollTimer = setInterval(() => void pollControls().catch(() => {}), 200);
			pollTimer.unref?.();
			await session.prompt(nextPrompt);
			clearInterval(pollTimer);
			pollTimer = undefined;
			while (polling) await new Promise((resolve) => setTimeout(resolve, 5));
			flushActivity();

			const current = store.get(id);
			if (terminal(current.status)) {
				state = store.state(current);
				break;
			}
			const providerError = session.agent.state.errorMessage;
			if (providerError || turnLimitReached) {
				state = store.beginFinishing(id, true);
				state.status = "failed";
				state.error = providerError ?? `Maximum turns reached (${launch.maxTurns})`;
				state.endedAt = Date.now();
				save();
				break;
			}

			const finishing = store.beginFinishing(id);
			if (finishing.status === "finishing") {
				state = finishing;
				const assistantTexts = session.messages.flatMap((message) => {
					return message.role === "assistant" ? textualContent(message.content) : [];
				}).filter(Boolean);
				state.result = (assistantTexts.at(-1) ?? "").slice(0, 65536);
				state.status = "completed";
				state.endedAt = Date.now();
				save();
				break;
			}
			if (reachedTurnLimit(state.turn, launch.maxTurns)) {
				state = store.beginFinishing(id, true);
				state.status = "failed";
				state.error = `Maximum turns reached (${launch.maxTurns}) before queued steering could run`;
				state.endedAt = Date.now();
				save();
				break;
			}

			const file = store.controlFiles(id)[0];
			if (!file) continue;
			const control = store.claimControl(id, file);
			if (!control) continue;
			if (control.value.kind === "stop") {
				store.finishControl(control);
				state = store.beginFinishing(id, true);
				state.status = "cancelled";
				state.endedAt = Date.now();
				save();
				break;
			}
			nextPrompt = control.value.text ?? "";
			activity("steer", nextPrompt);
			flushActivity();
			state.messageAcceptedAt = Date.now();
			save();
			store.finishControl(control);
		}
	} catch (error) {
		const current = store.get(id);
		if (terminal(current.status)) state = store.state(current);
		else {
			state = store.beginFinishing(id, true);
			state.status = "failed";
			state.error = error instanceof Error ? error.message : String(error);
			state.failureKind = "infrastructure";
			state.endedAt = Date.now();
			save();
		}
	} finally {
		if (pollTimer) clearInterval(pollTimer);
		if (activityTimer) clearTimeout(activityTimer);
		unsubscribe?.();
		try {
			session?.dispose();
		} catch {
			// The task state and transcript are already durable.
		}
		const current = store.get(id);
		state = store.state(current);
		if (!terminal(state.status)) {
			state = store.beginFinishing(id, true);
			state.status = "failed";
			state.error = "Subagent runner exited without a terminal state";
			state.failureKind = "infrastructure";
			state.endedAt = Date.now();
			save();
		}
		store.event(id, "terminal", { status: state.status, at: Date.now() });
		writeFileSync(join(store.taskDir(id), "done"), "", { mode: 0o600 });
		new Runtime(store).pumpQueue();
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
	if (process.argv[2] === "--smoke") process.exit(0);
	const [storeDir, id] = process.argv.slice(2);
	if (!storeDir || !id) throw new Error("usage: runner <store> <taskId>");
	await run(storeDir, id);
}
