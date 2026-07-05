---
name: prompt-vars
description: Use prompt vars for the active plan and design files, plus merged project/global agent-mode vars. Use when writing or updating agent prompts that should adapt to plan/design state, or when you need to inspect or mutate those vars at runtime.
---

# Prompt Vars

This environment provides:
- built-in derived prompt vars for the active plan and design files
- project vars from `.pi/agent-mode-vars.json`
- global fallback vars from `~/.pi/agent/agent-mode-vars.json`
- a project-local write-location config in `.pi/agent-mode-vars-config.json`
- a `vars` tool and `/vars` command for runtime inspection, bootstrap, and mutation

If you need the full wiring and implementation details, read:
- `extensions/z-prompt-vars/README.md`

## What they are for

Use prompt vars to make prompts adapt to the workspace and current runtime state without hardcoding absolute paths.

Typical uses:
- agent mode definitions
- other system-prompt-like text artifacts
- runtime inspection when you need the live value of a var
- workspace-local or user-global configuration that should persist across sessions

## Built-in derived prompt vars

These are computed at runtime and are read-only:
- `${plan.path}`
- `${plan.exists}`
- `${plan.active}`
- `${design.path}`
- `${design.exists}`
- `${design.active}`
- `${plan}`
- `${design}`

Meaning:
- `*.path` is the canonical active file path
- `*.exists` is `true` or `false`
- `*.active` is `true` when the corresponding mode is currently active (`planner` for plan, `designer` for design)
- `${plan}` and `${design}` expand to short status sentences

The source path vars for those built-ins are:
- `paths.plan`
- `paths.design`

If `paths.plan` or `paths.design` is unset, the extension falls back to:
- `.pi/plans/active.md`
- `.pi/designs/active.md`

## Read and write behavior

Read precedence:
1. project `.pi/<vars-file-name>`
2. global `~/.pi/agent/<vars-file-name>`

Project vars override global vars.

Writes go to the location selected by:
- `.pi/agent-mode-vars-config.json`

The config contains:

```json
{
  "pi-location": "project",
  "vars-file-name": "agent-mode-vars.json"
}
```

`pi-location` may be:
- `project`
- `global`

`vars-file-name` is optional and overrides the default vars filename while keeping the project/global directories fixed.
If a path is mistakenly provided, the extension keeps only the final path segment.

## Workspace vars

Examples of useful stored keys:
- `project.name`
- `feature.flag`
- `release.owner`
- `paths.design`
- `subagents.dispatch.defaultContext`
- `automode.enabled`

Recommended default:
- `subagents.dispatch.defaultContext = "fresh"`
- `automode.enabled = false`

Use `fork` only as an exception when a subagent truly needs prior session context.

## Runtime interfaces

### The `vars` tool

Agents should use the `vars` tool when they need a live value or need to update vars programmatically.

Examples:
- `vars({ action: "bootstrap" })`
- `vars({ action: "list" })`
- `vars({ action: "get", key: "plan.path" })`
- `vars({ action: "get", key: "project.name" })`
- `vars({ action: "set", key: "project.name", value: "Prompt Vars" })`
- `vars({ action: "set", key: "flags", value: { beta: true, rollout: 25 } })`
- `vars({ action: "set", key: "subagents.dispatch.defaultContext", value: "fresh" })`
- `vars({ action: "set", key: "subagents.dispatch.defaultContext", value: "fork" })`
- `vars({ action: "unset", key: "project.name" })`
- `vars({ action: "location" })`
- `vars({ action: "location", value: "global" })`

### The `/vars` command

Users can do the same interactively.

Examples:
- `/vars bootstrap`
- `/vars`
- `/vars plan.path`
- `/vars project.name`
- `/vars set project.name "Prompt Vars"`
- `/vars set flags '{"beta":true,"rollout":25}'`
- `/vars set subagents.dispatch.defaultContext "fresh"`
- `/vars set subagents.dispatch.defaultContext "fork"`
- `/vars unset project.name`
- `/vars location`
- `/vars location project`
- `/vars location global`

`/vars set` first tries to parse the value as JSON. If JSON parsing fails, it stores the raw text as a string.

## In prompt text

Write placeholders directly in the prompt.

Example:

```md
If the user refers to the saved plan, use `${plan.path}`.
If the user refers to the current design, use `${design.path}`.
Project: ${project.name}
Feature flags: ${flags}
${plan}
```

The prompt-vars extension interpolates these placeholders before each turn.

## Subagent dispatch example

The `~scout ...` and `~worker ...` dispatch flow can read a default context from:
- `subagents.dispatch.defaultContext`

Examples:
- `vars({ action: "set", key: "subagents.dispatch.defaultContext", value: "fresh" })`
- `/vars set subagents.dispatch.defaultContext "fresh"`
- `/vars set subagents.dispatch.defaultContext "fork"`

Prefer `fresh` as the default. Use `fork` only when the delegated task specifically benefits from prior session context.

## Automode

`automode.enabled` is a stored var used by the Designer → Planner → Builder automode workflow. Generic vars mutation may clear it to `false`, but must not start automode by setting it to `true`; start automode only with `/automode` from Designer. Builder should set it to `false` with the `vars` tool whenever automode completes, blocks, or stops for user input.

## Guidelines

- If the workspace is missing the expected agent-mode vars files, use `vars({ action: "bootstrap" })` instead of manually creating them.
- Prefer `fresh` as the normal default for `subagents.dispatch.defaultContext`.
- Treat `fork` as the exception case, not the baseline.
- Prefer the `vars` tool over guessing the value of a prompt var.
- Prefer scalar vars when you need a path or boolean fact.
- Prefer `${plan}` or `${design}` when you want a ready-made status sentence.
- Use `paths.plan` and `paths.design` when you need to change where the active plan or design file lives.
- Do not try to set the derived built-in facts `plan`, `plan.path`, `plan.exists`, `plan.active`, `design`, `design.path`, `design.exists`, or `design.active`.
- Do not hardcode the active plan/design paths in prompts when the built-in vars already exist.
- Remember that interpolation is a runtime capability. A prompt file only gets `${...}` expansion when it is loaded by a runtime that includes the prompt-vars extension.
- Remember that project vars override global vars on read.
