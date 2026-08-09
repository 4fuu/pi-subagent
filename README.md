# pi-subagent

Durable, low-noise subagents for [pi](https://github.com/earendil-works/pi). One narrow `subagent` tool launches, inspects, waits for, steers, and stops isolated child tasks. Work continues across parent tool calls and `/reload`, while readiness and completion arrive as automatic notifications.

## Usage

Talk to pi normally—the tool is designed for the model rather than as a command you invoke yourself.

> **You:** Locate the authorization checks and review whether this patch bypasses any of them. Keep working on the refactor while the review runs.
>
> **pi:** I’ll delegate the bounded review and continue the independent refactor.
>
> **pi → subagent:** `{"role":"reviewer","task":"Trace authorization checks relevant to the current patch. Report concrete bypasses with file locations; do not edit files."}`
>
> **subagent:** `{"taskId":"sa_…","status":"running","role":"reviewer"}`
>
> **pi:** continues its own work instead of polling.
>
> **Notification:** `sa_… completed · reviewer`
>
> **pi:** verifies the delegated findings against the repository, then incorporates them into its answer.

When the current turn needs the result, pi can wait on that same durable task:

```json
{"role":"scout","task":"Find the request validation entry point and return its call path.","wait":30}
```

For a long-running task, a literal can signal readiness before completion:

```json
{"role":"worker","task":"Start the development server and diagnose startup errors.","notifyOn":"ready on","wait":30}
```

The returned ID is the only handle needed for later operations:

```json
{"taskId":"sa_0123456789abcdefabcd"}
{"taskId":"sa_0123456789abcdefabcd","wait":30}
{"taskId":"sa_0123456789abcdefabcd","message":"Also check the fallback path."}
{"taskId":"sa_0123456789abcdefabcd","stop":true}
```

`wait` never creates a second execution mode. Every launch is the same durable task: omitted `wait` returns immediately; with `notifyOn`, waiting ends at the first case-sensitive literal match or terminal state; without it, waiting ends at terminal state. Timeout and tool abort end only the wait. `stop: true` is the only operation that terminates the child process tree. Queries are bounded, repeatable snapshots and do not consume output.

`wait` accepts `0..300` seconds on both launch and `taskId` calls. A steering `message` may be combined with `wait`; `stop` may not. A message response includes `messageQueuedAt` after its durable queue write; subsequent snapshots include `messageAcceptedAt` only after the child runner has actually consumed it.

## Roles

Roles are Markdown files. They are rediscovered for the current working directory before every parent agent run and again at launch, so the model always sees the current valid role list. There is no role-count limit.

Precedence from lowest to highest is:

1. Package defaults in `roles/`
2. User roles in `$PI_CODING_AGENT_DIR/subagents/` (normally `~/.pi/agent/subagents/`)
3. Project roles in `<cwd>/.pi/subagents/`

A valid higher-priority role replaces a role with the same name. An invalid file produces a visible diagnostic but never erases a valid lower-priority role.

### Role format

The filename must be `<name>.md`, and `name` must match the filename stem:

```markdown
---
name: security-reviewer
description: Review a bounded change for concrete security regressions.
tools: [read, grep, find, ls, bash]
model: anthropic/claude-sonnet-4-5
thinking: high
maxTurns: 20
---
Review only the delegated change. Do not edit files. Return findings ordered by
severity with exact locations, evidence, and the smallest safe fix.
```

Required fields are:

- `name`: `[a-z0-9][a-z0-9-]{0,63}`, equal to the filename stem
- `description`: one non-empty line, at most 160 characters
- `tools`: a YAML string array or comma-separated string

Optional fields are `model` (`provider/model`), `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`), and `maxTurns` (`1..100`, default `30`). Unknown fields are rejected. The Markdown body is the role system layer and must be non-empty and at most 32 KiB. `subagent` is always removed from the child tool list to prevent recursive delegation; an unavailable tool makes that task fail clearly instead of silently widening capability.

The package includes `scout`, `reviewer`, `worker`, and `oracle` defaults. They are ordinary role files and can be replaced through the same precedence rules.

## Isolation, persistence, and TUI

Children use pi’s official SDK and work on macOS, Linux, and Windows wherever pi and Node.js 22.19+ run. A child inherits the parent cwd, environment-backed authentication, model, and thinking level unless its role overrides model or thinking. It does **not** inherit the parent transcript or load parent extensions, skills, prompt templates, themes, or context files: the child receives the role body, a short fixed runtime contract, and the delegated task as a separate user message.

Up to four children run concurrently; additional tasks queue durably and promote in creation order. Metadata, a rolling 2 MiB visible JSONL transcript, controls, and notification markers live under `$PI_CODING_AGENT_DIR/subagents/tasks/` with private permissions. Records survive `/reload`; dead detached runners are reported as `orphaned`; completed records are cleaned after seven days or above 200 retained terminal tasks.

`notifyOn` is a 1–256 UTF-8 byte literal. It scans only child assistant text and textual tool results, including matches split across output chunks. It does not scan the role, delegated task, tool arguments, system prompt, progress-only updates, or hidden reasoning. Readiness fires once and does not end the child.

The dedicated **Subagents** widget shows at most three active tasks with ID, state/readiness, role, turn, duration, and latest activity. Tool rows stay compact by default; expansion adds model, thinking, role source, task, recent tools/activity, result, and errors. This widget and notification type are private to this plugin—pi-python and pi-pwsh remain independent plugins with only convergent parameter semantics.

## Installation

Install from npm:

```bash
pi install npm:@4fu/pi-subagent
```

Try it without installing:

```bash
pi -e npm:@4fu/pi-subagent
```

Or install the latest GitHub source:

```bash
pi install git:github.com/4fuu/pi-subagent
```

Requires pi 0.84.1+ and Node.js 22.19+.

## Development

```bash
npm install
npm test
npm pack --dry-run
```

## License

MIT
