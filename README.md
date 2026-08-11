# pi-subagent

[![Latest release](https://img.shields.io/github/v/release/4fuu/pi-subagent)](https://github.com/4fuu/pi-subagent/releases/latest)

Delegate bounded work to durable [pi](https://github.com/earendil-works/pi) sessions with fresh context, using roles you can read, version, and override as Markdown files.

## Why pi-subagent

Useful delegation needs a clear role boundary and a clean child context. `pi-subagent` makes both explicit, while letting the parent continue independent work and receive the result later.

- **Roles are files, not hidden code** — package defaults, user roles, and project roles share one strict Markdown format and precedence model.
- **Fresh context by design** — a child receives its role and delegated task, not a copy of the parent transcript or every installed extension and prompt.
- **The parent keeps moving** — children run durably in the background, queue when concurrency is full, and survive `/reload`.
- **Steer without starting over** — follow-up messages are durably queued and separately acknowledged when the child accepts them.
- **Bounded delegation** — each role controls tools, model, thinking level, and turn limit; recursive subagent access is always removed.
- **Results without progress chatter** — readiness and terminal notifications, bounded snapshots, and an aggregated background-task TUI keep child activity out of the main conversation until it matters.

Child sessions are created through pi's official SDK and use the same configured providers and authentication as the parent.

## Features

### Background delegation

Every delegation creates a persistent background task and returns immediately unless the current turn explicitly needs to wait. Waiting can end at completion or at an optional case-sensitive readiness phrase; a timeout or cancelled wait never stops the child.

The returned task ID lets the parent inspect a repeatable snapshot, wait again, send a bounded follow-up, or explicitly terminate the child process tree. Task IDs belong to the parent session that launched them, and reading a snapshot never consumes transcript output.

### Steering and durable execution

A steering `message` can be combined with `wait`; it cannot be combined with `stop`. The immediate response includes `messageQueuedAt` only after the message has been durably written. A later snapshot adds `messageAcceptedAt` after the runner consumes it.

Up to four children run concurrently. Additional tasks queue durably and are promoted in creation order. Metadata, controls, notifications, and a rolling 2 MiB visible JSONL transcript live under `$PI_CODING_AGENT_DIR/subagents/tasks/` with private permissions. Records survive `/reload`; dead detached runners are reported as `orphaned`; terminal records are cleaned after seven days or above 200 retained tasks.

### Fresh context, shared workspace

A child runs in a separate process with a fresh in-memory session and system prompt, but shares the parent's working directory, filesystem, and inherited environment. Its file changes are immediately visible in the same workspace; it is not a sandbox, container, or separate worktree. The child inherits the parent's model and thinking level unless its role overrides them, but does **not** inherit the parent transcript or load parent extensions, skills, prompt templates, themes, or context files.

The child receives three deliberate inputs:

1. A small fixed runtime contract describing child execution and completion.
2. The selected role's Markdown body as the role system layer.
3. The delegated task as a separate user message.

The `subagent` tool is always removed from child tool lists to prevent recursive delegation. Unavailable requested tools fail the task clearly instead of silently widening or changing its capabilities.

### Readiness, notifications, and TUI

`notifyOn` accepts a 1–256 UTF-8 byte literal. It scans child assistant text and textual tool results, including matches split across output chunks. It does not scan the role, delegated task, tool arguments, system prompt, progress-only updates, or hidden reasoning. Readiness fires once and does not complete the child.

Readiness and terminal notifications are durable and deduplicated. Successfully retrieving a ready snapshot cancels its pending readiness notification; retrieving a terminal snapshot cancels all pending notifications for that task.

Notifications are aggregated through the shared coordinator. Active and retained terminal tasks are published to the shared Tasks widget; run `/tasks` for the complete bounded catalog. Each plugin keeps its own independent runtime and durable task store. Upgrade all installed `@4fu` task plugins together when adopting the Tasks widget, since mixed legacy and current generations cannot share task presentation. Tool rows stay compact by default; expansion adds model, thinking, role source, task, recent tools and activity, result, and errors.

## Role configuration

Roles are Markdown files. The prompt catalog is snapshotted for the current working directory at session start (including reload, resume, and fork) and after successful compaction, so it stays stable between those boundaries. Every launch still rediscovers role files: valid edits take effect immediately even if the prompt catalog is older, while invalid Markdown fails that launch with its source path and parser diagnostic. There is no role-count limit.

Precedence from lowest to highest is:

1. Package defaults in `roles/`
2. User roles in `$PI_CODING_AGENT_DIR/subagents/` (normally `~/.pi/agent/subagents/`)
3. Project roles in `<cwd>/.pi/subagents/`

A valid higher-priority role replaces a role with the same name. An invalid higher-priority `<name>.md` shadows lower-priority definitions until fixed, produces a visible diagnostic, and returns the same detailed error if that role is launched.

### Markdown role format

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

Optional fields are `model` (`provider/model`), `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`), and `maxTurns` (`1..500`, default `256`). Unknown fields are rejected. The Markdown body is the role system layer and must be non-empty and at most 32 KiB. `subagent` is always removed from the child tool list to prevent recursive delegation; an unavailable tool makes that task fail clearly instead of silently widening capability.

The package includes one default role, `oracle`. It is an ordinary role file and can be replaced through the same precedence rules; add any other roles as user or project Markdown files.

### Role authoring skill

The package also includes the `creating-subagent-roles` skill. Use it when adding or refining a role: ask pi to create a pi-subagent role, or run `/skill:creating-subagent-roles` when skill commands are enabled. It inventories the current tools and models, chooses the appropriate role scope, and writes a valid role file.

## Requirements

- Pi 0.84.1 or newer.
- Node.js 22.19 or newer.
- macOS, Linux, or Windows wherever pi and the selected model provider are available.

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

### From source

Install dependencies, then register the repository as a local package so pi loads both the extension and bundled skill:

```bash
npm install
pi install /absolute/path/to/pi-subagent
```

Run `/reload` in pi after changing the extension or skill.

## Development

```bash
npm install
npm test
npm pack --dry-run
```

The test suite covers role discovery and precedence, strict frontmatter, fresh prompt context, task persistence, concurrency, session ownership, steering, notifications, turn limits, and process-tree termination.

## License

MIT
