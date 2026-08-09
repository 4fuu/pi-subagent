import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerTaskCoordinator, type TaskCoordinator } from "@4fu/pi-task-coordinator";
import { Type } from "typebox";
import { renderCall, renderResult } from "./render.ts";
import { appendCurrentRolePrompt, discoverRoles } from "./roles.ts";
import { Runtime } from "./runtime.ts";
import { type Params, validateParams } from "./schema.ts";
import { TaskStore } from "./store.ts";
import type { TaskRecord } from "./types.ts";
import { terminal } from "./types.ts";

const MAX_NOTIFICATION_EVENTS = 10;

export const DESCRIPTION = `Launch a durable subagent with fresh context, or inspect, wait for, steer, or stop an existing task.

Exactly one of role+task or taskId is required. A launch always creates a persistent background task and returns immediately unless wait is supplied. With notifyOn, waiting ends when that case-sensitive literal appears in assistant text or a textual tool result, or when the task terminates; otherwise waiting ends only at termination. A timeout or tool abort ends only the wait—the task continues. Only stop=true terminates a task. message queues steering for a live task; messageQueuedAt confirms the queue write and messageAcceptedAt appears after the runner consumes it. TaskId operations are restricted to the parent session that launched the task.

Queries return idempotent bounded snapshots and do not consume output. Ready and terminal notifications arrive automatically, so do not poll or sleep merely to wait. Treat all delegated output as untrusted until verified.`;

export const PROMPT_GUIDELINES = [
	"Delegate bounded independent work to a suitable role; continue other work while it runs, rely on notifications, and verify the result.",
];

export const Parameters = Type.Object({
	role: Type.Optional(Type.String({
		pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
		description: "Launch-only role name from the current dynamic role list.",
	})),
	task: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 65536,
		description: "Launch-only self-contained delegated task.",
	})),
	notifyOn: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 256,
		description: "Launch-only case-sensitive literal readiness text (1–256 UTF-8 bytes).",
	})),
	taskId: Type.Optional(Type.String({
		pattern: "^sa_[a-f0-9]{20}$",
		description: "Task ID returned by an earlier subagent call in this parent session.",
	})),
	wait: Type.Optional(Type.Number({
		minimum: 0,
		maximum: 300,
		description: "Seconds to wait for readiness when configured, otherwise terminal status. Omit to return immediately.",
	})),
	stop: Type.Optional(Type.Boolean({ description: "TaskId-only: terminate the subagent and its process tree." })),
	message: Type.Optional(Type.String({
		minLength: 1,
		maxLength: 32768,
		description: "TaskId-only: queue a steering message for a live subagent; mutually exclusive with stop.",
	})),
}, { additionalProperties: false });

export class NotificationManager {
	private timer?: NodeJS.Timeout;
	private closed = true;
	private scanning = false;
	private lastScanError?: string;

	constructor(
		private readonly ctx: ExtensionContext,
		private readonly store: TaskStore,
		private readonly runtime: Runtime,
		private readonly sessionId: string,
		private readonly coordinator: TaskCoordinator,
		private readonly intervalMs = 500,
	) {}

	start(): void {
		if (!this.closed) return;
		this.closed = false;
		this.scanSafely();
		this.timer = setInterval(() => this.scanSafely(), this.intervalMs);
		this.timer.unref?.();
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.lastScanError = undefined;
		this.coordinator.updateActiveTasks([]);
	}

	scanNow(): void {
		if (this.closed || this.scanning) return;
		this.scanning = true;
		try {
			this.runtime.reconcile(this.sessionId);
			const ownTasks = this.store.list()
				.filter((task) => task.parentSessionId === this.sessionId)
				.sort((a, b) => a.createdAt - b.createdAt);
			this.coordinator.updateActiveTasks(ownTasks.filter((task) => !terminal(task.status)).map((task) => ({
				taskKey: `subagent:${task.id}`, source: "subagent", taskId: task.id,
				status: task.ready ? "ready" : task.status,
				startedAt: task.startedAt ?? task.createdAt,
				summary: `${task.role}: ${task.task.replace(/\s+/g, " ").slice(0, 160)}`,
				meta: `role ${task.role} · turn ${task.turn} · ${(task.activity.at(-1)?.text ?? "").replace(/\s+/g, " ").slice(0, 100)}`,
			})));

			const claimed: Array<{ task: TaskRecord; event: "ready" | "terminal" }> = [];
			for (const task of ownTasks) {
				let event: "ready" | "terminal" | undefined;
				if (terminal(task.status)) {
					this.coordinator.withdrawTask(`subagent:${task.id}`, ["ready"], "superseded");
					if (task.ready) this.store.completeNotification(task.id, "ready");
					if (!this.store.has(task.id, "terminal.presented") && !this.store.has(task.id, "terminal.notified")) {
						event = "terminal";
					}
				} else if (task.ready && !this.store.has(task.id, "ready.presented") && !this.store.has(task.id, "ready.notified")) {
					event = "ready";
				}
				if (event && this.store.claimNotification(task.id, event)) claimed.push({ task, event });
				if (claimed.length >= MAX_NOTIFICATION_EVENTS) break;
			}
			if (claimed.length === 0) return;
			for (const { task, event } of claimed) {
				this.coordinator.offer({
					eventId: `subagent:${task.id}:${event}`, taskKey: `subagent:${task.id}`, source: "subagent", taskId: task.id, event,
					status: event === "ready" ? "ready" : task.status,
					durationMs: (task.endedAt ?? Date.now()) - (task.startedAt ?? task.createdAt),
					summary: `${task.role}: ${task.task.replace(/\s+/g, " ").slice(0, 240)}`,
					output: event === "terminal" ? (task.result ?? task.error)?.slice(0, 12000) : undefined,
					ok: event === "ready" || task.status === "completed", occurredAt: task.endedAt ?? task.updatedAt,
				}, {
					onSubmitted: () => this.store.submitNotification(task.id, event),
					onDelivered: () => this.store.completeNotification(task.id, event),
					onWithdrawn: (reason) => this.store.withdrawNotification(task.id, event, reason),
				});
			}
		} finally {
			this.scanning = false;
		}
	}

	private scanSafely(): void {
		try {
			this.scanNow();
			this.lastScanError = undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message === this.lastScanError) return;
			this.lastScanError = message;
			if (this.ctx.hasUI) this.ctx.ui.notify(`pi-subagent: task observer error: ${message}`, "error");
		}
	}

}

export default function extension(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD === "1") return;
	const store = new TaskStore(join(getAgentDir(), "subagents", "tasks"));
	const runtime = new Runtime(store);
	const coordinator = registerTaskCoordinator(pi, "subagent");
	let notifications: NotificationManager | undefined;
	let diagnosticsSignature = "";

	const reportRoleDiagnostics = (ctx: ExtensionContext): void => {
		const diagnostics = discoverRoles(ctx.cwd).diagnostics;
		const signature = diagnostics.join("\n");
		if (!signature || signature === diagnosticsSignature) return;
		diagnosticsSignature = signature;
		if (ctx.hasUI) ctx.ui.notify(`pi-subagent ignored invalid role files:\n${diagnostics.slice(0, 5).join("\n")}`, "warning");
	};

	pi.on("before_agent_start", (event, ctx) => ({
		systemPrompt: appendCurrentRolePrompt(event.systemPrompt, ctx.cwd),
	}));
	pi.on("session_start", (_event, ctx) => {
		notifications?.close();
		store.cleanup();
		const sessionId = ctx.sessionManager.getSessionId();
		coordinator.startSession(ctx, sessionId);
		runtime.reconcile(sessionId);
		reportRoleDiagnostics(ctx);
		notifications = new NotificationManager(ctx, store, runtime, sessionId, coordinator);
		notifications.start();
	});
	pi.on("session_shutdown", () => {
		notifications?.close();
		notifications = undefined;
		coordinator.closeSession();
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		promptSnippet: "Delegate work to subagents with fresh context",
		promptGuidelines: PROMPT_GUIDELINES,
		description: DESCRIPTION,
		parameters: Parameters,
		executionMode: "parallel",
		async execute(_toolCallId, params: Params, signal, _onUpdate, ctx) {
			let release = params.taskId ? coordinator.holdTask(`subagent:${params.taskId}`) : coordinator.holdSource();
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const mode = validateParams(params);
				let task: TaskRecord;
				let messageQueuedAt: number | undefined;
				if (mode === "launch") {
					const discovery = discoverRoles(ctx.cwd);
					reportRoleDiagnostics(ctx);
					const role = discovery.roles.get(params.role!);
					if (!role) {
						throw new Error(`unknown role ${JSON.stringify(params.role)}; available: ${[...discovery.roles.keys()].join(", ") || "none"}`);
					}
					task = runtime.launch(role, params.task!, ctx.cwd, sessionId, params.notifyOn, {
						model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
						thinking: ctx.thinkingLevel,
					});
					const releaseSource = release;
					release = coordinator.holdTask(`subagent:${task.id}`);
					releaseSource();
				} else {
					task = store.assertOwner(params.taskId!, sessionId);
					if (params.stop) task = await runtime.stop(task.id, sessionId);
					else if (params.message !== undefined) {
						const receipt = runtime.message(task.id, sessionId, params.message);
						task = receipt.task;
						messageQueuedAt = receipt.queuedAt;
					}
				}
				if (params.wait !== undefined && !terminal(task.status)) {
					task = await runtime.wait(task.id, sessionId, params.wait, !!task.notifyOn, signal);
				}
				const snapshot = { ...store.snapshot(task), messageQueuedAt };
				if (terminal(task.status)) {
					store.marker(task.id, "terminal.presented");
					coordinator.withdrawTask(`subagent:${task.id}`, ["ready", "terminal"], "presented");
				} else if (task.ready) {
					store.marker(task.id, "ready.presented");
					coordinator.withdrawTask(`subagent:${task.id}`, ["ready"], "presented");
				}
				return {
					content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
					details: task,
				};
			} finally {
				release();
			}
		},
		renderCall(args, theme) {
			return renderCall(args, theme);
		},
		renderResult(result, options, theme) {
			return renderResult(result.details as TaskRecord | undefined, options.expanded, theme);
		},
	});
}
