# pi-subagent

[![Latest release](https://img.shields.io/github/v/release/4fuu/pi-subagent)](https://github.com/4fuu/pi-subagent/releases/latest)

Durable, low-noise background subagents for [pi](https://github.com/earendil-works/pi), with Markdown-defined roles, isolated prompt layers, and automatic readiness and completion notifications.

## Why pi-subagent

Delegation is most useful when it gives the parent agent a narrow operation surface, predictable isolation, and a result it can verify without filling the main conversation with child progress. `pi-subagent` keeps those concerns behind one tool and a set of auditable Markdown roles.

- **One narrow task interface** — launch with a role and task; use the returned `taskId` to inspect, wait, steer, or stop.
- **Background by default** — every child is durable, so the parent can continue independent work instead of synchronously blocking or polling.
- **Low-noise notifications** — terminal state and optional literal readiness arrive automatically; snapshots never consume output.
- **Markdown-defined roles** — package, user, and project role files use the same strict format, with no hard-coded role-count limit.
- **Layered prompts** — the child receives a small runtime contract, the selected role body, and the delegated task as distinct layers.
- **Deliberate isolation** — children do not inherit the parent transcript, extensions, skills, prompt templates, themes, or context files.
- **Bounded steering** — a parent can durably queue a follow-up message without creating a second child or violating the role's turn budget.
- **Pi-native sessions** — children use pi's official SDK, model providers, authentication, tools, and TUI primitives.

This keeps the model-facing schema small and the prompt overhead stable while allowing users and projects to add as many specialized roles as they need.

## Features

### Background delegation

Talk to pi normally—the `subagent` tool is designed for the model rather than as a command you invoke yourself:

> **You:** Locate the authorization checks and review whether this patch bypasses any of them. Keep working on the refactor while the review runs.
>
> **pi:** I’ll delegate the bounded review and continue the independent refactor.
>
> **pi:** launches a durable `reviewer` task, receives `sa_…`, and continues its own work instead of polling.
>
> **Notification:** the reviewer task completed.
>
> **pi:** verifies the delegated findings against the repository, then incorporates them into its answer.

Every delegation creates a persistent background task and returns immediately unless the current turn explicitly needs to wait. Waiting can end at completion or at an optional case-sensitive readiness phrase; a timeout or cancelled wait never stops the child.

The returned task ID lets the parent inspect a repeatable snapshot, wait again, send a bounded follow-up, or explicitly terminate the child process tree. Task IDs belong to the parent session that launched them, and reading a snapshot never consumes transcript output.

### Steering and durable execution

A steering `message` can be combined with `wait`; it cannot be combined with `stop`. The immediate response includes `messageQueuedAt` only after the message has been durably written. A later snapshot adds `messageAcceptedAt` after the runner consumes it.

Up to four children run concurrently. Additional tasks queue durably and are promoted in creation order. Metadata, controls, notifications, and a rolling 2 MiB visible JSONL transcript live under `$PI_CODING_AGENT_DIR/subagents/tasks/` with private permissions. Records survive `/reload`; dead detached runners are reported as `orphaned`; terminal records are cleaned after seven days or above 200 retained tasks.

### Prompt and runtime isolation

A child inherits the parent working directory, environment-backed authentication, model, and thinking level unless its role overrides model or thinking. It does **not** inherit the parent transcript or load parent extensions, skills, prompt templates, themes, or context files.

The child receives three deliberate inputs:

1. A small fixed runtime contract describing child execution and completion.
2. The selected role's Markdown body as the role system layer.
3. The delegated task as a separate user message.

The `subagent` tool is always removed from child tool lists to prevent recursive delegation. Unavailable requested tools fail the task clearly instead of silently widening or changing its capabilities.

### Readiness, notifications, and TUI

`notifyOn` accepts a 1–256 UTF-8 byte literal. It scans child assistant text and textual tool results, including matches split across output chunks. It does not scan the role, delegated task, tool arguments, system prompt, progress-only updates, or hidden reasoning. Readiness fires once and does not complete the child.

Readiness and terminal notifications are durable and deduplicated. If the parent has already retrieved complete terminal output, a later notification is reduced to compact status instead of repeating the payload.

The dedicated **Subagents** widget shows up to three active tasks with ID, state or readiness, role, turn, duration, and latest activity. Tool rows stay compact by default; expansion adds model, thinking, role source, task, recent tools and activity, result, and errors. The widget and notification type belong only to this plugin.

## Role configuration

Roles are Markdown files. They are rediscovered for the current working directory before every parent agent run and again at launch, so the model always sees the current valid role list. There is no role-count limit.

Precedence from lowest to highest is:

1. Package defaults in `roles/`
2. User roles in `$PI_CODING_AGENT_DIR/subagents/` (normally `~/.pi/agent/subagents/`)
3. Project roles in `<cwd>/.pi/subagents/`

A valid higher-priority role replaces a role with the same name. An invalid file produces a visible diagnostic but never erases a valid lower-priority role.

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

Optional fields are `model` (`provider/model`), `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`), and `maxTurns` (`1..100`, default `30`). Unknown fields are rejected. The Markdown body is the role system layer and must be non-empty and at most 32 KiB. `subagent` is always removed from the child tool list to prevent recursive delegation; an unavailable tool makes that task fail clearly instead of silently widening capability.

The package includes `scout`, `reviewer`, `worker`, and `oracle` defaults. They are ordinary role files and can be replaced through the same precedence rules.


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

Run `npm install`, then add the repository path to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/path/to/pi-subagent"]
}
```

Run `/reload` in pi after changing the extension.

## Development

```bash
npm install
npm test
npm pack --dry-run
```

The test suite covers role discovery and precedence, strict frontmatter, prompt isolation, task persistence, concurrency, session ownership, steering, notifications, turn limits, and process-tree termination.

## License

MIT
