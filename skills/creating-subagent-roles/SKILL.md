---
name: creating-subagent-roles
description: Creates pi-subagent roles. Use when adding or refining one.
---

# Create a pi-subagent role

Create a reusable system layer for a fresh-context child agent, not a one-off task prompt.

## Inspect capabilities first

Do not draft the role until you have recorded the tools and models it can actually use.

1. Inspect the current session's `Available tools` definitions and identify the exact tool names relevant to the role. The child starts with extensions, skills, prompt templates, themes, and context files disabled, so parent-only extension tools are not available to it. Verify uncertain names against the installed Pi documentation or source; never guess.
2. Run `pi --list-models` with an available shell tool and record exact `provider/model` identifiers. If the command is unavailable, omit `model` rather than inventing one.
3. Decide whether the role is read-only or may change files, what evidence it must collect, and what the parent agent needs in the handoff.

Use the smallest useful tool set. `bash` can mutate files even in an otherwise read-only role, so include an explicit read-only constraint in the body when appropriate. Never include `subagent`; recursive delegation is unavailable.

Prefer omitting `model` and `thinking` so the child inherits the parent session. Pin them only when the role has a stable quality, latency, or cost requirement and the selected model appeared in the inventory. Give `maxTurns` the smallest realistic budget; narrow read-only work usually needs fewer turns than implementation.

## Choose the destination

- Reusable across projects: `$PI_CODING_AGENT_DIR/subagents/<name>.md`, normally `~/.pi/agent/subagents/<name>.md`.
- Specific to the current trusted project: `<cwd>/.pi/subagents/<name>.md`.
- Package default: `roles/<name>.md`, only when editing the pi-subagent package itself.

Project roles override user roles, which override package defaults. Do not edit an installed npm package to create a user or project role. If scope is not stated, use project scope for repository-specific behavior and user scope for generally reusable behavior; ask only when that distinction materially changes the result.

## Write for the child

The role body is injected as the child's system layer. The delegated task arrives separately as a user message. The child has no parent transcript and should not be told to rely on prior discussion. It shares the parent's working directory and filesystem, so its edits are immediately visible.

Write direct instructions to the child:

- Start with the bounded mission, not biography such as “You are a helpful agent.”
- Define in-scope work, prohibited side effects, and when to stop.
- State whether files may be edited and which verification is expected.
- Make the final answer a self-contained handoff: exact paths, evidence, checks, assumptions, and unresolved blockers as appropriate.
- Tell the child to report a blocker or explicit assumption instead of asking the parent questions it cannot receive synchronously.
- Keep stable role behavior here; leave repository-specific facts and the immediate assignment in the delegated task.
- Avoid greetings, progress narration, generic advice, and instructions to delegate again.

The role description is shown to the parent model for routing. Keep it to one short sentence that says both capability and timing, for example:

```yaml
description: Maps an unfamiliar code path. Use before implementation or debugging.
```

## Role format

Use this shape, omitting optional fields that are not justified:

```markdown
---
name: focused-role-name
description: Produces a bounded outcome. Use when that outcome is needed.
tools: [read, grep, find, ls]
model: provider/model
thinking: high
maxTurns: 16
---
Handle the delegated task independently within its stated scope.

- Work from repository evidence; do not assume parent context.
- Do not modify files.
- Verify consequential claims with exact locations.

Return a concise handoff containing findings, evidence, and unresolved uncertainty.
```

Required frontmatter:

- `name`: matches the filename stem and `[a-z0-9][a-z0-9-]{0,63}`.
- `description`: one non-empty line, at most 160 characters.
- `tools`: a YAML array or comma-separated string of verified tool names.

Optional frontmatter is limited to `model` (`provider/model`), `thinking` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`), and `maxTurns` (`1..500`, default `256`). Unknown fields are invalid. The body must be non-empty and at most 32 KiB.

## Validate

Before finishing:

1. Re-read the file and confirm its filename, `name`, description, tools, and optional values meet the format exactly.
2. Confirm every tool and explicit model came from the capability inventory.
3. Remove task-specific wording that would make the role unsafe or misleading on its next invocation.
4. Report the file path, intended use, selected tools, model inheritance or override, and any assumption you could not verify.

Roles are rediscovered before parent runs and again at launch, so a valid new role does not require `/reload`.
