import { Text } from "@earendil-works/pi-tui";
import type { TaskRecord } from "./types.ts";

export function duration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function callLine(args: { taskId?: string; role?: string; task?: string; wait?: number; stop?: boolean; message?: string }): string {
	if (args.taskId) {
		const action = args.stop ? "stop" : args.message !== undefined ? "steer" : args.wait !== undefined ? `wait ${args.wait}s` : "inspect";
		return `subagent ${args.taskId} · ${action}`;
	}
	const action = args.wait !== undefined ? `launch · wait ${args.wait}s` : "launch";
	return `subagent ${args.role ?? "?"} · ${action}\n${(args.task ?? "").replace(/\s+/g, " ").slice(0, 160)}`;
}

export function resultLines(task: TaskRecord, expanded: boolean): string[] {
	const elapsed = duration((task.endedAt ?? Date.now()) - (task.startedAt ?? task.createdAt));
	const head = `subagent ${task.id} ${task.status} · ${task.role} · turn ${task.turn} · ${elapsed}`;
	const latest = task.activity.at(-1);
	if (!expanded) {
		return [head, `  ${(latest?.text ?? task.task).replace(/\s+/g, " ").slice(0, 140)}`];
	}
	return [
		head,
		`  model ${task.model ?? "inherited/default"} · thinking ${task.thinking ?? "inherited/default"} · tokens ${task.tokens ?? "—"}`,
		`  role ${task.roleSource}`,
		`  task ${task.task.replace(/\s+/g, " ").slice(0, 300)}`,
		...task.activity.slice(-8).map((entry) => `  ${entry.kind}: ${entry.text.replace(/\s+/g, " ").slice(0, 180)}`),
		...(task.result ? [`  result: ${task.result.slice(0, 4000)}`] : []),
		...(task.error ? [`  error: ${task.error}`] : []),
	];
}

export function renderCall(args: Parameters<typeof callLine>[0], theme: any): Text {
	const [head, ...body] = callLine(args).split("\n");
	return new Text([
		theme.fg("toolTitle", theme.bold(head?.split(" · ")[0] ?? "subagent")),
		theme.fg("dim", head?.includes(" · ") ? ` · ${head.split(" · ").slice(1).join(" · ")}` : ""),
		...(body.length > 0 ? [`\n${theme.fg("toolOutput", body.join("\n"))}`] : []),
	].join(""), 0, 0);
}

export function renderResult(task: TaskRecord | undefined, expanded: boolean, theme: any): Text {
	if (!task) return new Text(theme.fg("muted", "subagent"), 0, 0);
	const lines = resultLines(task, expanded);
	const tone = task.status === "completed" ? "success"
		: task.status === "failed" || task.status === "orphaned" ? "error"
			: task.status === "cancelled" ? "warning" : "accent";
	const [head, ...rest] = lines;
	return new Text([
		theme.fg(tone, head ?? "subagent"),
		...rest.map((line) => `\n${theme.fg(line.trimStart().startsWith("error:") ? "error" : "toolOutput", line)}`),
	].join(""), 0, 0);
}
