import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
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

test("strict role parser supports Pi frontmatter and removes recursive access", () => {
	const role = parseRole(markdown(), "/a/x.md");
	assert.equal(role.description, "useful");
	assert.deepEqual(role.tools, ["read"]);
	assert.equal(role.maxTurns, 12);
	assert.equal(parseRole(markdown().replace("maxTurns: 12\n", ""), "/a/x.md").maxTurns, 30);
	assert.throws(() => parseRole(markdown().replace("tools:", "wat: z\ntools:"), "/a/x.md"), /unknown/);
	assert.throws(() => parseRole(markdown("y"), "/a/x.md"), /filename/);
	assert.throws(() => parseRole(markdown().replace("maxTurns: 12", "maxTurns: 0"), "/a/x.md"), /1 to 100/);
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
	assert.ok(PROMPT_GUIDELINES.every((line) => !/foreground|jobId|runId/.test(line)));
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

test("store snapshots are bounded, private, and terminal state is immutable", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "store-")));
	createTask(store, { id: id("2"), sessionId: "one", result: "x".repeat(20000) });
	const task = store.get(id("2"));
	assert.equal(store.snapshot(task).activity.length, 12);
	assert.equal(store.snapshot(task).result?.length, 12000);
	assert.match(resultLines(task, true).join("\n"), /turn 2/);
	assert.equal(statSync(store.dir).mode & 0o777, 0o700);

	const completed = store.state(task);
	completed.status = "completed";
	completed.endedAt = Date.now();
	store.saveState(task.id, completed);
	const stale = store.state(task);
	stale.status = "running";
	assert.equal(store.saveState(task.id, stale).status, "completed");
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

test("notification leases retry after failure and recover after expiry", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "notify-lease-")));
	createTask(store, { id: id("41"), sessionId: "one", status: "completed", result: "done" });
	let attempts = 0;
	const pi = { sendMessage: () => {
		attempts++;
		if (attempts === 1) throw new Error("injected send failure");
	} } as never;
	const ctx = { hasUI: false, mode: "print", ui: { setWidget() {}, notify() {} } } as never;
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	const manager = new NotificationManager(pi, ctx, store, runtime, "one", 10000);
	manager.start();
	assert.equal(store.has(id("41"), "terminal.notifying"), false);
	manager.scanNow();
	assert.equal(attempts, 2);
	assert.equal(store.has(id("41"), "terminal.notified"), true);
	manager.close();

	createTask(store, { id: id("42"), sessionId: "one", status: "completed" });
	assert.equal(store.claimNotification(id("42"), "terminal"), true);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	assert.equal(store.claimNotification(id("42"), "terminal", 0), true);
	store.completeNotification(id("42"), "terminal");
	assert.equal(store.has(id("42"), "terminal.notified"), true);
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

test("explicit terminal presentation suppresses notification output and sessions stay isolated", () => {
	const store = new TaskStore(mkdtempSync(join(tmpdir(), "notify-")));
	createTask(store, { id: id("7"), sessionId: "one", status: "completed", result: "done" });
	createTask(store, { id: id("8"), sessionId: "two", status: "completed", result: "secret" });
	store.marker(id("7"), "terminal.presented");
	const sent: unknown[] = [];
	const widgets: unknown[] = [];
	const pi = { sendMessage: (message: unknown) => sent.push(message) } as never;
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: { setWidget: (...args: unknown[]) => widgets.push(args) },
	} as never;
	const runtime = new Runtime(store, "/unused.ts", (() => fakeSpawn()) as never);
	const manager = new NotificationManager(pi, ctx, store, runtime, "one", 10000);
	manager.start();
	manager.close();
	assert.equal(sent.length, 1);
	assert.doesNotMatch(JSON.stringify(sent), /done|secret/);
	assert.ok(widgets.length > 0);
});
