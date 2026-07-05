# z-prompt-vars

A prompt-variable and prompt-interpolation extension for Pi.

This extension does two related jobs:

1. it interpolates `${...}` placeholders in an agent's system prompt before each turn
2. it exposes a runtime interface for reading and writing agent-mode vars through `/vars` and the `vars` tool

It also defines a small set of built-in derived vars for the active plan and design files.

## What problem this solves

Without this extension, agent prompt files either need to hardcode absolute paths or contain unresolved placeholders such as `${plan.path}`.

With this extension loaded, prompt authors can write prompt text like:

```md
Current plan: ${plan.path}
Current design: ${design.path}
Project: ${project.name}
${plan}
```

and the placeholders are resolved from a combination of:
- agent-mode vars loaded from project and global config files
- derived runtime facts such as whether the plan/design file exists
- the current agent mode, for example whether `planner` or `designer` is active

## Files involved

### Extension entry point

`extensions/z-prompt-vars/index.ts`

This file is the runtime entry point. It:
- bootstraps missing project/global vars files on session start
- registers the `before_agent_start` hook
- registers the `/vars` command
- registers the `vars` tool
- parses command/tool requests
- delegates actual var resolution and storage to `prompt-vars.ts`

### Core var and interpolation logic

`extensions/z-prompt-vars/prompt-vars.ts`

This file contains the core implementation. It:
- reads merged vars from project and global config files
- writes vars to the configured write target
- bootstraps the initial project/global vars files when requested
- manages the tiny write-location config file
- flattens nested stored values into dot-path keys
- computes the built-in derived vars for plan/design
- merges stored vars with derived vars for interpolation and listing
- protects reserved derived keys from being directly written

### Skill documentation for agents

`skills/prompt-vars/SKILL.md`

This file does not implement the feature. It teaches agents:
- that the vars exist
- when to use the `vars` tool
- how to use `${...}` placeholders in prompt text
- which keys are writable and which are derived

## Storage model

### Vars files

Project vars live at:

`<cwd>/.pi/agent-mode-vars.json`

Global fallback vars live at:

`~/.pi/agent/agent-mode-vars.json`

Project vars override global vars when both are present.

### Write-location config

The extension also uses a tiny project-local config file:

`<cwd>/.pi/agent-mode-vars-config.json`

It always contains `pi-location` and may also contain an optional vars filename override:

```json
{
  "pi-location": "project",
  "vars-file-name": "agent-mode-vars.json"
}
```

Allowed values for `pi-location`:
- `project`
- `global`

`vars-file-name` is optional. When present, it overrides the default filename for both project and global vars while keeping the directories fixed.

If a user mistakenly puts a path there instead of just a filename, the extension keeps only the final path segment. For example:
- `custom/agent-vars.json` → `agent-vars.json`
- `/tmp/agent-vars.json` → `agent-vars.json`

This config controls where `/vars set`, `/vars unset`, and the `vars` tool write changes, and which vars filename is used inside the fixed project/global directories.

When bootstrap creates the initial vars files, it seeds:
- `paths.plan = ".pi/plans/active.md"` unless the project file is being created and a global `paths.plan` already exists
- `paths.design = ".pi/designs/active.md"` unless the project file is being created and a global `paths.design` already exists
- `subagents.dispatch.defaultContext = "fresh"`
- `automode.enabled = false`

Allowed dispatch defaults:
- `fresh`
- `fork`
- `continue`

Recommendation:
- use `fresh` as the normal subagent dispatch default
- use `fork` only when a subagent truly needs prior session context
- use `continue` when you want repeated direct user `~subagent` messages to stay in the same delegated conversation until reload or shutdown

## High-level data flow

1. Pi starts and loads the package resources from `package.json`.
2. Pi loads `extensions/z-prompt-vars/index.ts`.
3. Before each agent turn, the extension runs `buildPromptVars(...)` from `prompt-vars.ts`.
4. `buildPromptVars(...)` reads project vars, global vars, and the write-location config.
5. The write-location config supplies the write target and optional vars filename override.
6. Project vars are merged over global vars.
7. Built-in derived vars are computed from the merged config.
8. The extension interpolates `${...}` placeholders in the system prompt text.
9. On session start, the extension bootstraps missing project/global vars files if needed.
10. During the turn, the user or agent can inspect, bootstrap, or mutate vars with:
   - `/vars ...`
   - `vars({ action: ... })`
11. Mutations write to either the project or global vars file based on `pi-location`, using the configured vars filename.

## Built-in plan/design behavior

The extension treats `paths.plan` and `paths.design` specially.

They are ordinary stored vars in the merged config, but they also drive the built-in derived vars.

Defaults when unset:
- `paths.plan` → `.pi/plans/active.md`
- `paths.design` → `.pi/designs/active.md`

Both are resolved relative to the current working directory unless an absolute path is stored.

Built-in derived keys are:
- `plan`
- `plan.path`
- `plan.exists`
- `plan.active`
- `design`
- `design.path`
- `design.exists`
- `design.active`

## Read precedence and merge behavior

Resolution order is:

1. project vars from `<cwd>/.pi/<vars-file-name>`
2. global vars from `~/.pi/agent/<vars-file-name>`

Merge behavior is:
- global vars provide defaults
- project vars override global vars
- derived plan/design vars are computed from the merged result

## Interpolation behavior

Interpolation happens in the `before_agent_start` hook in `index.ts`.

Rules:
- placeholder syntax is `${key}`
- unknown placeholders are left unchanged
- stored scalar values interpolate as strings
- stored non-scalar values interpolate as compact JSON text
- built-in derived vars interpolate as strings

## `/vars` command

Supported forms:

```text
/vars bootstrap
/vars
/vars plan.path
/vars project.name
/vars set project.name "Prompt Vars"
/vars set flags '{"beta":true,"rollout":25}'
/vars set subagents.dispatch.defaultContext "fork"
/vars set subagents.dispatch.defaultContext "continue"
/vars unset project.name
/vars location
/vars location project
/vars location global
```

`/vars bootstrap` creates the initial project/global vars files if they are missing and does not overwrite existing files. Project path defaults are not seeded over existing global `paths.plan` or `paths.design` values.

`/vars set` first tries to parse the value as JSON. If JSON parsing fails, the raw text is stored as a string.

`/vars location` shows the current write target, the effective vars filename, and the config paths.

`/vars location project|global` switches where future writes go.

## `vars` tool

The tool supports these actions:
- `bootstrap`
- `list`
- `get`
- `set`
- `unset`
- `location`

Examples:

```json
{ "action": "bootstrap" }
{ "action": "list" }
{ "action": "get", "key": "plan.path" }
{ "action": "set", "key": "project.name", "value": "Prompt Vars" }
{ "action": "unset", "key": "project.name" }
{ "action": "location" }
{ "action": "location", "value": "global" }
```

## Ordinary stored keys

Examples of useful stored keys:
- `project.name`
- `feature.flag`
- `release.owner`
- `paths.design`
- `subagents.dispatch.defaultContext`
- `automode.enabled`
- `footer.colors.subagentStatus.running`
- `footer.colors.subagentStatus.queued`
- `footer.colors.subagentStatus.complete`
- `footer.colors.subagentStatus.cancelled`
- `footer.colors.subagentStatus.failed`
- `footer.colors.subagentSeparator`

Recommended default for subagent dispatch:
- `subagents.dispatch.defaultContext = "fresh"`

Automode default:
- `automode.enabled = false`

Builder should clear `automode.enabled=false` with the `vars` tool when automode stops. Setting `automode.enabled=true` is intentionally blocked through generic vars mutation; start automode with `/automode` from Designer.

Use `fork` only as an exception when delegated work truly needs prior session context.
Use `continue` when you want direct user `~subagent` follow-ups to reuse the same delegated conversation for the current parent session.

The user-addressed subagent dispatch flow reads:
- `subagents.dispatch.defaultContext`

`continue` also has a shorthand flag at the input line:
- `--continue`
- `--cont`

If a continued thread is already active, the user gets a short `scout is busy` style message instead of starting a second concurrent continued thread.

Continued user subagent context is in-memory only and resets on reload or restart.

Subagent footer status colors can be overridden with hex values:

```text
/vars set footer.colors.subagentStatus.running "#71e37d"
/vars set footer.colors.subagentStatus.queued "#f0c986"
/vars set footer.colors.subagentStatus.complete "#bababa"
/vars set footer.colors.subagentStatus.cancelled "#874a4a"
/vars set footer.colors.subagentStatus.failed "#FF4D4D"
```

Because project vars override global vars, you can set a team-wide global default and override it in a specific workspace.

## In prompt text

Write placeholders directly in the prompt:

```md
If the user refers to the saved plan, use `${plan.path}`.
If the user refers to the current design, use `${design.path}`.
Project: ${project.name}
Feature flags: ${flags}
${plan}
```

The prompt-vars extension interpolates these placeholders before each turn.

## Important rules

- Prefer the `vars` tool over guessing the value of a prompt var.
- If the workspace is missing the expected agent-mode vars files, use bootstrap rather than manually writing them.
- Prefer `${plan}` or `${design}` when you want a ready-made status sentence.
- Use `paths.plan` and `paths.design` when you need to change where the active plan or design file lives.
- Do not try to set the derived built-in facts `plan`, `plan.path`, `plan.exists`, `plan.active`, `design`, `design.path`, `design.exists`, or `design.active`.
- Project vars override global vars on read.
- Writes go to the location selected by `pi-location`.
- The vars filename defaults to `agent-mode-vars.json` and may be overridden by `vars-file-name`.

## Troubleshooting

### A key is missing

Common causes:
- it is not present in either vars file
- it is overridden by a project value you did not expect
- the key is misspelled
- the config file is malformed and the extension fell back to defaults

### `/vars location` says `global` but you expected project writes

Check:
- `<cwd>/.pi/agent-mode-vars-config.json`
- the `pi-location` value inside it

### The subagent dispatch default context is not what you expected

Check these keys in order:
- project `subagents.dispatch.defaultContext`
- global `subagents.dispatch.defaultContext`

## Summary

This extension now uses:
- merged project and global vars
- project-over-global precedence on read
- a project-local write-location config
- package-specific filenames to avoid collisions
