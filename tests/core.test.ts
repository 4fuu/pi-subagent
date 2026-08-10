import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";
import type { TaskCoordinator, TaskNotificationCallbacks, TaskNotificationUpdate } from "@4fu/pi-task-coordinator";
import type { PresentedTask, TaskReporter } from "@4fu/pi-tasks";
import { DESCRIPTION, NotificationManager, PROMPT_GUIDELINES } from "../src/index.ts";
import { resultLines } from "../src/render.ts";
import { appendCurrentRolePrompt, discoverRoles, parseRole } from "../src/roles.ts";
import { LiteralMatcher, reachedTurnLimit, steeringAllowed, turnLimitWouldTruncate } from "../src/runner.ts";
import { Runtime } from "../src/runtime.ts";
import { validateParams } from "../src/schema.ts";
import { TaskStore } from "../src/store.ts";
import type { Launch, State, Status } from "../src/types.ts";

const id = (suffix: string) => `sa_${suffix.padStart(20, "0")}`;
const markdown = (name = "x", description = "useful") => `---
name: ${name}
description: "${description}"
tools: [read, subagent]
maxTurns: 12
---
Do one thing.`;

function createTask(store: TaskStore, options: {
	id: string;
	sessionId: string;
	status?: Status;
	pid?: number;
	createdAt?: number;
	ready?: boolean;
	result?: string;
	failureKind?: "infrastructure";
}): void {
	const createdAt = options.createdAt ?? Date.now();
	const launch: Launch = {
		id: options.id,
		parentSessionId: options.sessionId,
		role: "x",
		roleSource: "/x.md",
		roleBody: "Do one thing.",
		task: "hello",
		cwd: process.cwd(),
		createdAt,
		maxTurns: 30,
		tools: ["read"],
	};
	const state: State = {
		status: options.status ?? "running",
		updatedAt: createdAt,
		pid: options.pid,
		ready: options.ready,
		result: options.result,
		failureKind: options.failureKind,
		turn: 2,
		activity: Array.from({ length: 20 }, (_, index) => ({ at: createdAt, kind: "tool", text: String(index) })),
	};
	store.create(launch, state);
}

function fakeSpawn(): ChildProcess {
	const child = new EventEmitter() as ChildProcess;
	Object.defineProperty(child, "pid", { value: 777777, configurable: true });
	child.unref = () => child;
	return child;
}

function fakeCoordinator(offers: Array<{ update: TaskNotificationUpdate; callbacks?: TaskNotificationCallbacks }> = []): TaskCoordinator {
	return {
		offer(update: TaskNotificationUpdate, callbacks?: TaskNotificationCallbacks) { offers.push({ update, callbacks }); },
		withdrawTask() {},
	} as unknown as TaskCoordinator;
}

function fakeReporter(catalogs: PresentedTask[][] = []): TaskReporter {
	return {
		publishCatalog(_sessionId, tasks) { catalogs.push(tasks.map((task) => ({ ...task }))); },
		close() {},
	};
}

test("detached runner starts through jiti with Pi import aliases", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "runner-start-")));
	let invocation: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
	const runtime = new Runtime(store, undefined, ((executable: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv } | undefined) => {
		invocation = { executable, args, env: options!.env as NodeJS.ProcessEnv };
		return fakeSpawn();
	}) as never);
	runtime.launch({
		name: "x",
		description: "test",
		tools: [],
		maxTurns: 1,
		body: "test",
		source: "/x.md",
	}, "test", process.cwd(), "one");

	assert.ok(invocation);
	assert.equal(invocation.executable, process.execPath);
	assert.equal(invocation.args[0], "--import");
	assert.equal(new URL(invocation.args[1]!).protocol, "file:");
	assert.match(fileURLToPath(invocation.args[1]!), /[/\\]src[/\\]loader\.mjs$/);
	assert.doesNotMatch(invocation.args.join(" "), /experimental-(?:strip|transform)-types/);
	assert.equal(invocation.env.PI_SUBAGENT_CHILD, "1");
	const aliases = JSON.parse(invocation.env.JITI_ALIAS!) as Record<string, string>;
	assert.match(aliases["@earendil-works/pi-coding-agent"]!, /[/\\]pi-coding-agent[/\\]dist[/\\]index\.js$/);
	assert.match(aliases["@earendil-works/pi-agent-core"]!, /[/\\]pi-agent-core[/\\]dist[/\\]index\.js$/);
	assert.match(aliases["@earendil-works/pi-ai"]!, /[/\\]pi-ai[/\\]dist[/\\]compat\.js$/);
	assert.match(aliases["@earendil-works/pi-ai/providers/all"]!, /[/\\]pi-ai[/\\]dist[/\\]providers[/\\]all\.js$/);
	assert.match(aliases["@earendil-works/pi-tui"]!, /[/\\]pi-tui[/\\]dist[/\\]index\.js$/);

	const smoke = spawnSync(invocation.executable, ["--import", invocation.args[1]!, invocation.args[2]!, "--smoke"], {
		env: invocation.env,
		encoding: "utf8",
	});
	assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
});

test("strict role parser supports Pi frontmatter and removes recursive access", () => {
	const role = parseRole(markdown(), "/a/x.md");
	assert.equal(role.description, "useful");
	assert.deepEqual(role.tools, ["read"]);
	assert.equal(role.maxTurns, 12);
	assert.equal(parseRole(markdown().replace("maxTurns: 12\n", ""), "/a/x.md").maxTurns, 256);
	assert.equal(parseRole(markdown().replace("maxTurns: 12", "maxTurns: 500"), "/a/x.md").maxTurns, 500);
	assert.throws(() => parseRole(markdown().replace("tools:", "wat: z\ntools:"), "/a/x.md"), /unknown/);
	assert.throws(() => parseRole(markdown("y"), "/a/x.md"), /filename/);
	assert.throws(() => parseRole(markdown().replace("maxTurns: 12", "maxTurns: 0"), "/a/x.md"), /1 to 500/);
	assert.throws(() => parseRole(markdown().replace("maxTurns: 12", "maxTurns: 501"), "/a/x.md"), /1 to 500/);
});

test("role discovery is package < user < project and invalid overrides preserve valid roles", () => {
	const root = mkdtempSync(join(tmpdir(), "roles-"));
	const packageDir = join(root, "package");
	const userDir = join(root, "user");
	const project = join(root, "project");
	mkdirSync(packageDir);
	mkdirSync(userDir);
	mkdirSync(join(project, ".pi", "subagents"), { recursive: true });
	writeFileSync(join(packageDir, "x.md"), markdown("x", "package"));
	writeFileSync(join(userDir, "x.md"), markdown("x", "user"));
	writeFileSync(join(project, ".pi", "subagents", "x.md"), "bad");
	const discovery = discoverRoles(project, { packageDir, userDir });
	assert.equal(discovery.roles.get("x")?.description, "user");
	assert.equal(discovery.diagnostics.length, 1);

	writeFileSync(join(project, ".pi", "subagents", "x.md"), markdown("x", "project"));
	assert.equal(discoverRoles(project, { packageDir, userDir }).roles.get("x")?.description, "project");
});

test("dynamic role prompt replaces its previous layer and follows cwd", () => {
	const root = mkdtempSync(join(tmpdir(), "role-prompt-"));
	const packageDir = join(root, "package");
	const userDir = join(root, "user");
	const first = join(root, "first");
	const second = join(root, "second");
	for (const directory of [packageDir, userDir, join(first, ".pi", "subagents"), join(second, ".pi", "subagents")]) {
		mkdirSync(directory, { recursive: true });
	}
	writeFileSync(join(first, ".pi", "subagents", "one.md"), markdown("one"));
	writeFileSync(join(second, ".pi", "subagents", "two.md"), markdown("two"));
	const firstPrompt = appendCurrentRolePrompt("base", first, { packageDir, userDir });
	const secondPrompt = appendCurrentRolePrompt(firstPrompt, second, { packageDir, userDir });
	assert.match(firstPrompt, /one: useful/);
	assert.doesNotMatch(secondPrompt, /one: useful/);
	assert.match(secondPrompt, /two: useful/);
	assert.match(secondPrompt, /Available subagent roles:/);
	assert.doesNotMatch(secondPrompt, /Launch one with/);
	assert.equal((secondPrompt.match(/<pi_subagent_roles>/g) ?? []).length, 1);
});

test("schema exposes one narrow launch/query surface with UTF-8 bounds", () => {
	assert.equal(validateParams({ role: "x", task: "t" }), "launch");
	assert.equal(validateParams({ taskId: id("1") }), "query");
	for (const params of [
		{ role: "x" },
		{ task: "t" },
		{ role: "x", task: "t", taskId: id("1") },
		{ role: "x", task: "t", stop: false },
		{ taskId: id("1"), stop: true, message: "x" },
		{ taskId: id("1"), stop: true, wait: 1 },
		{ taskId: id("1"), notifyOn: "x" },
		{ taskId: "sa_x" },
		{ role: "x", task: "t", notifyOn: "界".repeat(86) },
	]) assert.throws(() => validateParams(params));
	assert.doesNotThrow(() => validateParams({ role: "x", task: "t", notifyOn: "界".repeat(85), wait: 300 }));
	assert.doesNotThrow(() => validateParams({ taskId: id("1"), message: "continue", wait: 0.25 }));
	assert.match(DESCRIPTION, /Only stop=true terminates/);
	assert.match(DESCRIPTION, /fresh context/);
	assert.doesNotMatch(DESCRIPTION, /isolated/);
	assert.deepEqual(PROMPT_GUIDELINES, [
		"Delegate bounded independent work to a suitable role; continue other work while it runs, rely on notifications, and verify the result.",
	]);
});

test("literal readiness matches across chunks but not across reset streams", () => {
	const matcher = new LiteralMatcher("界-ready");
	assert.equal(matcher.feed("prefix-界-re"), false);
	assert.equal(matcher.feed("ady-suffix"), true);
	matcher.reset();
	assert.equal(matcher.feed("界-re"), false);
	matcher.reset();
	assert.equal(matcher.feed("ady"), false);
	assert.equal(reachedTurnLimit(3, 3), true);
	assert.equal(reachedTurnLimit(2, 3), false);
	assert.equal(turnLimitWouldTruncate(3, 3, false, false), false);
	assert.equal(turnLimitWouldTruncate(3, 3, true, false), true);
	assert.equal(turnLimitWouldTruncate(3, 3, false, true), true);
	assert.equal(steeringAllowed(2, 3, true), true);
	assert.equal(steeringAllowed(3, 3, true), false);
});

test("model snapshots are compact while durable state and expanded TUI stay rich", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "store-")));
	createTask(store, { id: id("2"), sessionId: "one", result: "x".repeat(20000) });
	const task = store.get(id("2"));
	const snapshot = store.snapshot(task);
	assert.deepEqual(snapshot.activity, [17, 18, 19].map((text) => ({ kind: "tool", text: String(text) })));
	assert.equal(snapshot.result?.length, 12000);
	assert.equal("durationMs" in snapshot, false);
	assert.equal("ready" in JSON.parse(JSON.stringify(snapshot)), false);
	assert.equal(store.get(task.id).activity.length, 20);
	assert.equal(JSON.parse(readFileSync(join(store.taskDir(task.id), "state.json"), "utf8")).activity.length, 20);
	const expanded = resultLines(task, true).join("\n");
	assert.match(expanded, /turn 2/);
	assert.match(expanded, /role \/x\.md/);
	assert.match(expanded, /task hello/);
	assert.match(expanded, /tool: 19/);
	assert.match(expanded, /result:/);
	assert.equal(statSync(store.dir).mode & 0o777, 0o700);

	const completed = store.state(task);
	completed.status = "completed";
	completed.endedAt = Date.now();
	store.saveState(task.id, completed);
	const terminalSnapshot = store.snapshot(store.get(task.id));
	assert.equal("activity" in JSON.parse(JSON.stringify(terminalSnapshot)), false);
	assert.equal("ready" in JSON.parse(JSON.stringify(terminalSnapshot)), false);
	assert.equal(terminalSnapshot.diagnosticsPath, undefined);
	const stale = store.state(task);
	stale.status = "running";
	assert.equal(store.saveState(task.id, stale).status, "completed");
});

test("diagnostics paths identify only failed, orphaned, and corrupt existing tasks", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "diagnostics-")));
	for (const [suffix, status, failureKind] of [
		["70", "failed", undefined],
		["71", "failed", "infrastructure"],
		["72", "orphaned", "infrastructure"],
		["73", "cancelled", undefined],
		["74", "running", undefined],
	] as const) {
		createTask(store, { id: id(suffix), sessionId: "one", status, failureKind });
		assert.equal(store.snapshot(store.get(id(suffix))).diagnosticsPath, failureKind ? store.taskDir(id(suffix)) : undefined);
	}
	const corrupt = id("75");
	mkdirSync(store.taskDir(corrupt));
	writeFileSync(join(store.taskDir(corrupt), "state.json"), "not json");
	assert.throws(() => store.get(corrupt), new RegExp(`corrupt or unreadable; diagnosticsPath: ${store.taskDir(corrupt)}`));
	assert.throws(() => store.get(id("76")), /unknown taskId/);
	assert.throws(() => store.get("foreign"), /invalid taskId/);
});

test("taskId read, wait, stop, and message reject another parent session", async () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "ownership-")));
	createTask(store, { id: id("3"), sessionId: "owner", status: "queued" });
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	assert.throws(() => store.assertOwner(id("3"), "other"), /another session/);
	assert.throws(() => runtime.message(id("3"), "other", "hello"), /another session/);
	await assert.rejects(() => runtime.wait(id("3"), "other", 0), /another session/);
	await assert.rejects(() => runtime.stop(id("3"), "other"), /another session/);
	assert.equal((await runtime.stop(id("3"), "owner")).status, "cancelled");
});

test("message and stop controls are separate durable records", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "controls-")));
	createTask(store, { id: id("4"), sessionId: "owner", pid: process.pid });
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	runtime.message(id("4"), "owner", "change direction");
	store.control(id("4"), "stop");
	assert.equal(store.controlFiles(id("4")).length, 2);
	const kinds = store.controlFiles(id("4")).map((file) => store.claimControl(id("4"), file)!).map((control) => control.value.kind).sort();
	assert.deepEqual(kinds, ["message", "stop"]);
});

test("finishing rejects new steering without dropping an already queued message", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "finishing-")));
	createTask(store, { id: id("40"), sessionId: "owner", pid: process.pid });
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	const receipt = runtime.message(id("40"), "owner", "one more thing");
	assert.ok(receipt.queuedAt > 0);
	assert.equal(store.beginFinishing(id("40")).status, "running");
	const control = store.claimControl(id("40"), store.controlFiles(id("40"))[0]!)!;
	store.finishControl(control);
	assert.equal(store.beginFinishing(id("40")).status, "finishing");
	assert.throws(() => runtime.message(id("40"), "owner", "too late"), /no longer accepting/);
});

test("notification claims transition through submitted and delivered and stale leases recover", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "notify-lease-")));
	createTask(store, { id: id("41"), sessionId: "one", status: "completed", result: "done" });
	const offers: Array<{ update: TaskNotificationUpdate; callbacks?: TaskNotificationCallbacks }> = [];
	const ctx = { hasUI: false, mode: "print", ui: { setWidget() {}, notify() {} } } as never;
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	const manager = new NotificationManager(ctx, store, runtime, "one", fakeCoordinator(offers), fakeReporter(), 10000);
	manager.start();
	assert.equal(offers.length, 1);
	assert.equal(store.has(id("41"), "terminal.notifying"), true);
	offers[0]!.callbacks?.onSubmitted?.("delivery");
	assert.equal(store.has(id("41"), "terminal.submitted"), true);
	manager.scanNow();
	assert.equal(offers.length, 1);
	offers[0]!.callbacks?.onDelivered?.("delivery");
	assert.equal(store.has(id("41"), "terminal.notified"), true);
	manager.close();

	createTask(store, { id: id("42"), sessionId: "one", status: "completed" });
	assert.equal(store.claimNotification(id("42"), "terminal"), true);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	assert.equal(store.claimNotification(id("42"), "terminal", 0), true);
	store.completeNotification(id("42"), "terminal");
	assert.equal(store.has(id("42"), "terminal.notified"), true);

	createTask(store, { id: id("45"), sessionId: "one", status: "completed", result: "recover me" });
	assert.equal(store.claimNotification(id("45"), "terminal"), true);
	store.submitNotification(id("45"), "terminal");
	const submitted = join(store.taskDir(id("45")), "events", "terminal.submitted");
	const stale = new Date(Date.now() - 60_000);
	utimesSync(submitted, stale, stale);
	store.submitNotification(id("45"), "terminal");
	assert.ok(Date.now() - statSync(submitted).mtimeMs < 1_000);
	const resumedOffers: Array<{ update: TaskNotificationUpdate; callbacks?: TaskNotificationCallbacks }> = [];
	const resumed = new NotificationManager(ctx, store, runtime, "one", fakeCoordinator(resumedOffers), fakeReporter(), 10000);
	resumed.start();
	assert.equal(resumedOffers.some(({ update }) => update.taskId === id("45")), false);
	utimesSync(submitted, stale, stale);
	resumed.scanNow();
	assert.equal(resumedOffers.some(({ update }) => update.taskId === id("45")), true);
	resumed.close();
});

test("busy notification leases do not starve later offerable tasks", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "notify-busy-cap-")));
	const createdAt = Date.now() - 1_000;
	for (let index = 50; index < 60; index++) {
		createTask(store, { id: id(String(index)), sessionId: "one", status: "completed", createdAt: createdAt + index });
		assert.equal(store.claimNotification(id(String(index)), "terminal"), true);
		store.submitNotification(id(String(index)), "terminal");
	}
	createTask(store, { id: id("60"), sessionId: "one", status: "completed", createdAt: createdAt + 60, result: "available" });
	const offers: Array<{ update: TaskNotificationUpdate; callbacks?: TaskNotificationCallbacks }> = [];
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	const manager = new NotificationManager({ hasUI: false, ui: {} } as never, store, runtime, "one", fakeCoordinator(offers), fakeReporter(), 10000);
	manager.start();
	assert.deepEqual(offers.map(({ update }) => update.taskId), [id("60")]);
	manager.close();
});

test("withdrawal clears pending delivery and superseded ready cannot re-offer", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "notify-withdraw-")));
	createTask(store, { id: id("43"), sessionId: "one", ready: true, pid: process.pid });
	assert.equal(store.claimNotification(id("43"), "ready"), true);
	store.submitNotification(id("43"), "ready");
	store.withdrawNotification(id("43"), "ready", "presented");
	assert.equal(store.has(id("43"), "ready.submitted"), false);
	assert.equal(store.claimNotification(id("43"), "ready"), true);
	store.withdrawNotification(id("43"), "ready", "superseded");
	assert.equal(store.has(id("43"), "ready.notified"), true);
	assert.equal(store.claimNotification(id("43"), "ready"), false);
	assert.equal(store.claimNotification(id("43"), "terminal"), true);
	store.submitNotification(id("43"), "terminal");
	store.withdrawNotification(id("43"), "terminal", "retry-exhausted");
	assert.equal(store.has(id("43"), "terminal.submitted"), false);
	assert.equal(store.has(id("43"), "terminal.notifying"), true);
	assert.equal(store.claimNotification(id("43"), "terminal"), false);
});

test("terminal state durably supersedes readiness across observer reloads", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "notify-terminal-ready-")));
	createTask(store, { id: id("44"), sessionId: "one", status: "completed", ready: true, result: "done" });
	store.marker(id("44"), "ready.submitted");
	const offers: Array<{ update: TaskNotificationUpdate; callbacks?: TaskNotificationCallbacks }> = [];
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	const manager = new NotificationManager({ hasUI: false, ui: {} } as never, store, runtime, "one", fakeCoordinator(offers), fakeReporter(), 10000);
	manager.start();
	manager.close();
	assert.equal(store.has(id("44"), "ready.submitted"), false);
	assert.equal(store.has(id("44"), "ready.notified"), true);
	assert.deepEqual(offers.map(({ update }) => update.event), ["terminal"]);
});

test("dead runners become orphaned and queued work promotes without cross-record writes", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "queue-")));
	createTask(store, { id: id("5"), sessionId: "one", pid: 99999999, createdAt: Date.now() - 20000 });
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	runtime.reconcile("one");
	assert.equal(store.get(id("5")).status, "orphaned");

	for (let index = 10; index < 14; index++) createTask(store, { id: id(String(index)), sessionId: "one", pid: process.pid });
	createTask(store, { id: id("20"), sessionId: "two", status: "queued" });
	let state = store.state(store.get(id("10")));
	state.status = "completed";
	state.endedAt = Date.now();
	store.saveState(id("10"), state);
	runtime.pumpQueue();
	assert.equal(store.get(id("20")).status, "starting");
});

test("aborting a wait leaves the task untouched", async () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "wait-")));
	createTask(store, { id: id("6"), sessionId: "one", pid: process.pid });
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error("cancel wait")), 10);
	await assert.rejects(() => runtime.wait(id("6"), "one", 10, false, controller.signal), /cancel wait/);
	assert.equal(store.get(id("6")).status, "running");
});

test("explicit terminal presentation suppresses notification output and sessions remain owner-scoped", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "notify-")));
	createTask(store, { id: id("7"), sessionId: "one", status: "completed", result: "done" });
	createTask(store, { id: id("8"), sessionId: "two", status: "completed", result: "secret" });
	store.marker(id("7"), "terminal.presented");
	const offers: Array<{ update: TaskNotificationUpdate; callbacks?: TaskNotificationCallbacks }> = [];
	const catalogs: PresentedTask[][] = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { notify() {} },
	} as never;
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	const manager = new NotificationManager(ctx, store, runtime, "one", fakeCoordinator(offers), fakeReporter(catalogs), 10000);
	manager.start();
	assert.deepEqual(catalogs[0]!.map(({ taskId, phase, statusLabel }) => ({ taskId, phase, statusLabel })), [
		{ taskId: id("7"), phase: "completed", statusLabel: "completed" },
	]);
	manager.close();
	assert.equal(offers.length, 0);
	assert.deepEqual(catalogs.at(-1), []);
});

test("ready offers include bounded summaries and active role/turn/activity metadata", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "notify-summary-")));
	createTask(store, { id: id("9"), sessionId: "one", ready: true, pid: process.pid });
	const offers: Array<{ update: TaskNotificationUpdate; callbacks?: TaskNotificationCallbacks }> = [];
	const catalogs: PresentedTask[][] = [];
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	const manager = new NotificationManager({ hasUI: false, ui: {} } as never, store, runtime, "one", fakeCoordinator(offers), fakeReporter(catalogs), 10000);
	manager.start();
	assert.equal(offers[0]!.update.eventId, `subagent:${id("9")}:ready`);
	assert.equal(offers[0]!.update.taskKey, `subagent:${id("9")}`);
	assert.match(offers[0]!.update.summary!, /^x: hello/);
	assert.deepEqual(catalogs[0]![0], {
		taskKey: `subagent:${id("9")}`,
		source: "subagent",
		taskId: id("9"),
		phase: "active",
		statusLabel: "ready",
		createdAt: catalogs[0]![0]!.createdAt,
		updatedAt: catalogs[0]![0]!.updatedAt,
		startedAt: undefined,
		endedAt: undefined,
		summary: "x: hello",
		meta: "role x · turn 2 · 19",
	});
	manager.close();
	assert.deepEqual(catalogs.at(-1), []);
});
