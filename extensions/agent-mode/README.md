# agent-mode

`agent-mode` is the mode-switching layer for `picode`.

Its job is simple but important: it turns one Pi session into a set of named operating modes with different prompts, tools, models, thinking levels, and delegated-subagent allowances.

If `picode` is the overall workflow package, `agent-mode` is the part that answers the question:

> What kind of agent should Pi be right now?

---

## What it does

`agent-mode` loads mode definitions from markdown files in `agents/` and applies them to the main Pi agent.

A mode can change:

- the persona and instruction text
- the active tools
- the preferred model
- the preferred thinking level
- the gate profile to use
- which delegated subagents are allowed
- the footer color/status

The built-in package ships modes for:

- Builder
- Planner
- Designer
- Code-Reviewer

---

## User surface

### Commands

```text
/mode
/mode next
/mode prev
/mode <name>
```

Examples:

```text
/mode Builder
/mode Planner
/mode Designer
/mode Code-Reviewer
```

### Keyboard shortcuts

Configured in `settings.json`.

Shipped defaults:

- `Ctrl+.` → next mode
- `Ctrl+,` → previous mode

### Footer status

`agent-mode` shows the current mode in the footer/status area using the configured mode color when one is set.

---

## LLM surface

For each turn, `agent-mode` does two main things for the main agent.

### 1. It applies runtime constraints

Depending on the selected mode, it can set:

- active tools
- thinking level
- model

### 2. It injects the mode prompt

Before the main agent starts a turn, `agent-mode` prepends a structured mode-specific system prompt built from the selected mode's frontmatter and markdown body.

That prompt includes things like:

- the canonical mode name
- the gate profile
- the active tools and bash policy
- the allowed delegated subagents
- the preferred model and thinking level
- the mode-specific instructions from the markdown body

The result is that the agent does not merely "remember" a mode. It receives a fresh explicit mode contract every turn.

---

## Mode file format

Mode files live in `agents/*.md`.

Example shape:

```md
---
name: Builder
description: Implement requested changes directly with full mutation tools.
profile: builder
color: #FF4D4D
tools: [read, bash, edit, write, grep, find, ls, delegate_subagent, delegate_subagent_status]
subagents: scout, generalist
bash: full
thinking: high
model: openai-codex/gpt-5.4
maxSubagentDepth: 2
---
Implement the requested change directly and finish unless blocked.
```

### Frontmatter fields

| Field | Purpose |
| --- | --- |
| `name` | Display name and canonical mode label |
| `description` | Short human summary |
| `profile` | pi-gate profile to switch to |
| `color` | Footer/status color |
| `tools` | Active tools for the main agent |
| `subagents` | Subagents this mode may delegate to |
| `bash` | `full` or `read-only` |
| `thinking` | Preferred thinking level |
| `model` | Preferred model |
| `maxSubagentDepth` | Depth ceiling used by the delegation stack |

The markdown body is the real instruction payload for the mode.

---

## Dependencies and relationships

### Strong relationship with pi-gate

`agent-mode` emits a profile-switch event that `pi-gate` can follow. That is how mode changes and permission changes stay in sync.

If you use `agent-mode` without `pi-gate`, mode switching still works, but the permission side of the workflow is gone.

### Strong relationship with prompt-vars

The shipped mode prompts refer to values like `${plan.path}` and `${design.path}`. Those placeholders are resolved by `z-prompt-vars`.

If you use `agent-mode` without `z-prompt-vars`, you lose that interpolation layer.

### Relationship with subagent orchestration

Mode files also declare which delegated subagents are allowed. `subagent-orchestrator` reads that mode state and enforces it.

So `agent-mode` does not execute subagents itself, but it does decide which ones the main agent is allowed to call.

---

## Standalone usefulness

`agent-mode` is absolutely usable on its own if you want:

- named personas
- tool presets
- model/thinking presets
- quick mode switching

It becomes much more interesting when combined with:

- `pi-gate` for permissions
- `z-prompt-vars` for prompt interpolation
- `subagent-orchestrator` for delegation

---

## One important implementation detail

`agent-mode` is for the **main agent session**.

Delegated subagent children intentionally skip `agent-mode` so that a child scout or generalist runs from its own subagent card instead of accidentally inheriting the parent's top-level mode persona.

That separation keeps Builder, Planner, Designer, and Code-Reviewer as top-level modes, and keeps scout/generalist as true delegated personas.
