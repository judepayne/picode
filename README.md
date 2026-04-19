![picode logo](./img/picode.svg)

`picode` is a Pi package for running Pi with a disciplined, role-based workflow that still feels fast and powerful.

It is also my homage to the Opencode features I liked most: multiple agent personas, permission profiles, and quick keyboard navigation between them. In practice, that usually means a deliberate loop of **Designer → Planner → Builder → Code-Reviewer**, which helps keep architecture work, planning, implementation, and review from collapsing into one blurry role.

What makes this package exciting is not just that it gives Pi “modes.” It gives you a way to turn one generic coding assistant into a small, organized system:

- a **Designer** who helps shape the solution
- a **Planner** who turns that into an implementation handoff
- a **Builder** who actually changes the code
- a **Code-Reviewer** who checks the work critically
- plus delegated helpers like **scout** and **generalist** when the main agent needs backup

And those are not just prompt labels. Modes can change:

- the active prompt and persona
- the active tools
- the model and thinking level
- the permission profile
- which subagents are allowed

That combination is what gives the package its bite. You are not just telling Pi to “act like a planner.” You are putting it into a runtime that behaves like one.

This package bundles those ideas into one coherent setup for Pi:

- **agent-mode** for mode switching and persona prompts
- **pi-gate** for OpenCode-style permission profiles
- **subagent-orchestrator** for mediated delegation to package-defined subagents
- **subagent-mode** as the child-runner substrate behind delegation
- **z-prompt-vars** for prompt interpolation and runtime vars
- **skills** that teach the agent how to use the package well
- **package-local `agents/` and `subagents/` assets** that define the built-in modes and delegated personas

The short version is: this package gives you a structured way to tell Pi **what kind of agent it should be right now**, **what it is allowed to do**, **what supporting subagents it may call**, and **what project-specific plan/design context should be injected into prompts**.

To make that more concrete, these are the kinds of things this package makes practical:

```text
/mode Designer
```

```text
~scout find every place where LibraryX is used and group the results by subsystem
```

```text
~generalist implement the smallest safe fix for the failing parser test and run the relevant test file
```

Or, without using the shorthand directly:

> Spawn three scout subagents in parallel and run them async: one should review the API layer, one the persistence layer, and one the frontend state layer for code-quality risks. Then bring back a concise comparison of the most important issues.

That is the real promise of `picode`: not just more knobs, but a workflow that feels more like coordinating a disciplined little engineering team.

Just as importantly, the system is meant to be **extended**. The built-in modes and subagents are not hardcoded into the runtime; they are authored as package-local markdown assets. If you like the workflow but want different personas, different helper specialists, or a different house style, you can add your own mode cards and subagent cards instead of forking the whole architecture.

---

## Contents

- [What this package gives you](#what-this-package-gives-you)
- [Install and reload](#install-and-reload)
- [Start here in one minute](#start-here-in-one-minute)
- [The default working style](#the-default-working-style)
- [User surface](#user-surface)
- [LLM-agent surface](#llm-agent-surface)
- [Components and dependencies](#components-and-dependencies)
- [What is configurable](#what-is-configurable)
- [Extending agents and subagents](#extending-agents-and-subagents)
- [Package layout and state locations](#package-layout-and-state-locations)
- [Which parts are reusable on their own](#which-parts-are-reusable-on-their-own)
- [Further reading](#further-reading)

---

## What this package gives you

### 1. Mode switching for the main agent

The top-level agent can be switched between named modes such as:

- **Designer**
- **Planner**
- **Builder**
- **Code-Reviewer**

Each mode has its own:

- persona and instructions
- allowed tools
- allowed delegated subagents
- preferred model
- preferred thinking level
- associated permission profile

That means the same Pi session can behave like a design partner, then a planner, then an implementation assistant, then a reviewer, without you rewriting the whole prompt every time.

In other words, you can stop trying to get one giant prompt to do everything at once.

### 2. Permission profiles that follow the mode

The package pairs each mode with a **pi-gate** profile. When you switch modes, the permission profile switches with it.

That gives you a very useful separation of concerns:

- the **mode prompt** shapes how the agent should think and talk
- the **gate profile** shapes what the agent is allowed to do

For example, Planner and Code-Reviewer can be read-only in practice even if the model would otherwise be capable of editing.

That is one of the package's most useful discipline-enforcing features: the role changes, and the permission envelope changes with it.

### 3. Managed delegation to subagents

The package includes mediated subagent delegation with built-in child personas such as:

- **scout** for fast reconnaissance
- **generalist** for unattended implementation or validation work

Delegation is not a free-for-all. The current mode decides which subagents are allowed, and the orchestrator controls how runs are launched, tracked, surfaced, and handed back.

That means you can do things like:

- send a scout to map where a library is used
- launch several scouts in parallel to review different subsystems
- send a generalist to apply a bounded fix while the parent keeps context and oversight
- build nested workflows where delegated helpers can themselves coordinate smaller delegated tasks under a depth limit

This is where the package starts to feel genuinely powerful.

### 4. Prompt vars for plan and design driven workflows

The package includes prompt vars so prompts can refer to things like:

- the active plan path
- the active design path
- whether those files exist
- stored project/global variables
- the preferred default subagent context

This avoids hardcoding paths into prompts and makes the same prompt files portable between projects.

It also makes the built-in modes much more practical, because the same Planner or Builder prompt can adapt to whichever project it is running in.

### 5. Package-local agent and subagent assets

The mode and subagent definitions live inside this package in:

- `agents/`
- `subagents/`

Those are **package assets**, not mutable user state. Mutable state stays in the workspace or in Pi's normal user directories.

That separation is important: prompts and persona definitions ship with the package, while plans, designs, vars, sessions, and orchestrator state stay where they belong.

### 6. A workflow that is opinionated in a useful way

A lot of AI tooling gives you raw capability. `picode` tries to give you **usable structure**.

The point is not just that Pi can do many things. The point is that it can do them in a way that encourages better habits:

- design before code
- planning before implementation when needed
- implementation with bounded permissions
- explicit review instead of self-congratulation
- delegated helpers when the scope is broad enough to justify them

---

## Install and reload

### Local-path install for active development

```bash
pi install -l /Users/jude/Dropbox/Projects/agent/picode
```

### Global install

```bash
pi install /Users/jude/Dropbox/Projects/agent/picode
```

After installation, start Pi or reload an existing session:

```text
/reload
```

Because local-path installs are not copied into a separate build artifact, edits in this repository are normally picked up after `/reload`.

---

## Start here in one minute

1. Install the package.
2. Run `/reload`.
3. Check the current mode with `/mode`.
4. Switch modes with either:
   - `/mode Designer`
   - `/mode Planner`
   - `/mode Builder`
   - `/mode Code-Reviewer`
   - or the keyboard shortcuts `Ctrl+,` and `Ctrl+.`
5. Let prompt-vars bootstrap its files automatically, or run `/vars bootstrap` explicitly.
6. Try one or two delegation examples so you can feel the package working:
   - `~scout find every place where configuration is loaded`
   - `~scout --fork use the current debugging context and identify the strongest root-cause candidates`
   - `~generalist implement the smallest safe fix for the failing parser test and run the relevant test file`

If you do nothing else, the default high-value workflow is:

1. **Designer** to shape the solution
2. **Planner** to write or refine the implementation plan
3. **Builder** to make the change
4. **Code-Reviewer** to review the result

If you want the “oh, that’s cool” demo, this is a good natural-language example to try with the main agent:

> Spawn three scout subagents in parallel and run them async: one should review the API layer, one the persistence layer, and one the frontend state layer for code-quality risks. Then bring back a concise comparison of the most important issues.

---

## The default working style

This package is opinionated. Its main goal is not to make Pi do more things at once. Its goal is to make Pi do the **right kind of work at the right time**.

That is the through-line of the whole project: more structure, less blur.

A typical disciplined loop looks like this:

### Designer
Use when the problem is still fuzzy.

Designer is for:

- architecture
- interfaces
- boundaries
- tradeoffs
- shaping the work before code changes

### Planner
Use when the direction is clear enough to turn into an implementation handoff.

Planner is for:

- grounding a plan in the actual repository
- clarifying scope and sequencing
- writing the active handoff plan

### Builder
Use when the request is ready to implement.

Builder is for:

- direct code changes
- focused validation
- delegating supporting research or parallel work when useful

### Code-Reviewer
Use when you want an actual review pass rather than more implementation.

Code-Reviewer is for:

- correctness
- regression risk
- maintainability
- structured findings by severity

This separation is the point. The mode switch is meant to change both the prompt and the permission envelope so the agent stays in role.

---

## User surface

In this README, **user surface** means the things a human Pi user directly sees or types.

### Commands and shortcuts

| Surface | Who uses it | Purpose |
| --- | --- | --- |
| `/mode` | User | Show the current mode and available modes |
| `/mode next` / `/mode prev` / `/mode <name>` | User | Switch the current mode |
| `Ctrl+.` / `Ctrl+,` | User | Cycle forward/backward through modes |
| `/gate` / `/gate status` | User | Inspect the current gate profile and policy state |
| `/gate switch` | User | Pick a gate profile manually |
| `/gate clear` | User | Clear cached session approvals |
| `/vars` | User | Inspect prompt vars and derived plan/design values |
| `/vars bootstrap` | User | Create the expected vars/config files if missing |
| `/vars set ...` / `/vars unset ...` / `/vars location ...` | User | Manage stored vars and write location |
| `~scout ...` / `~generalist ...` | User | Launch an async delegated subagent run from the prompt line |

### Footer/status surfaces

The package also uses Pi's status/footer area to surface the current runtime state.

You will typically see some combination of:

- the **current mode name** from `agent-mode`
- the **current gate profile** from `pi-gate`
- subagent activity such as active runs or queued handbacks from `subagent-orchestrator`

### User-facing subagent dispatch

The cleanest user-facing delegation surface is the `~subagent` syntax at the start of an interactive input line.

Examples:

```text
~scout inspect how the config is loaded
~scout --fresh compare how configuration is loaded in the CLI and the server
~scout --fork use the current debugging context and identify the strongest root-cause candidates
~generalist implement the smallest safe fix and run the relevant tests
```

Important details:

- it must be at the **start of the first line**
- it only works for subagents allowed by the **current mode**
- it launches an **async** delegated run
- `--fresh` and `--fork` override the context for that run
- if you omit the context, the default comes from prompt-vars configuration; this package seeds that default to **`fresh`** on bootstrap

This is one of the most immediately satisfying parts of the package, because it makes delegated help feel lightweight instead of ceremonial.

### Asking the main agent to orchestrate work for you

You also do not need to use the `~subagent` shorthand directly.

A lot of the time, the most natural thing is simply to tell the main agent what kind of delegated work you want.

Examples:

> Create a scout subagent to find every place where `<LibraryX>` is used and group the results by subsystem.

> Spawn three scout subagents in parallel and run them async: one should review the API layer, one the persistence layer, and one the frontend state layer for code-quality risks. Then bring back a concise comparison of the most important issues.

> Create an async chain of generalist subagents. First, review `ModuleX` for code quality and maintainability issues. Second, apply the smallest safe cleanup for the highest-value issue. Third, summarize exactly what changed and any follow-up work still worth doing.

That is where the package starts to feel especially strong: you can talk at a high level, and the system underneath can turn that into a structured delegated workflow.

### What users do **not** call directly

Some package features are real Pi tools, but they are primarily intended for the main agent rather than for direct human use.

In particular:

- `delegate_subagent`
- `delegate_subagent_status`
- `vars`

A user normally reaches those through ordinary conversation, through `/vars`, or through the `~scout` style shorthand.

---

## LLM-agent surface

In this README, **LLM surface** means the things the model itself sees or can call while generating answers.

### The main agent sees

When the main agent starts a turn, the package layers several things together:

1. **The current mode prompt** from `agents/*.md`
2. **Interpolated prompt vars** from `z-prompt-vars`
3. **Tool constraints** from the active mode
4. **Model and thinking preferences** from the active mode
5. **Permission enforcement** from `pi-gate`
6. **Relevant skills** discovered by Pi from `skills/`

That means the main agent's effective runtime is shaped by the selected mode, not just by a static base prompt.

### The main agent can call

The most important agent-facing tools in this package are:

- `delegate_subagent(...)`
- `delegate_subagent_status(...)`
- `vars(...)`

#### `delegate_subagent`

This is the agent-facing delegation API.

It supports:

- single runs
- parallel fan-out
- sequential chains
- `fresh` or `fork` context
- sync or async execution
- optional visible run cards

Examples:

```ts
await delegate_subagent({ task: "inspect the parser" })
await delegate_subagent({ agent: "generalist", task: "apply the fix" })
await delegate_subagent({ tasks: [{ task: "inspect A" }, { task: "inspect B" }], async: true })
await delegate_subagent({ chain: [{ task: "inspect" }, { task: "summarize findings" }] })
```

#### `delegate_subagent_status`

This is the inspection/control surface for delegated runs.

It supports actions such as:

- `list`
- `get`
- `cancel`
- `next`
- `prev`
- `select`
- `tree`
- `log`
- `stream`
- `stream_next`

It is mainly for situations where the agent needs to inspect an in-flight or completed delegated run in detail.

#### `vars`

This is the agent-facing runtime interface for prompt vars.

It supports:

- `bootstrap`
- `list`
- `get`
- `set`
- `unset`
- `location`

### What delegated subagents see

Delegated subagents do **not** just see the parent mode prompt copied into a child process.

Instead, a delegated child is launched from its own subagent card in `subagents/*.md`, which currently supplies:

- instructions/body prompt
- model
- thinking level
- tools
- max subagent depth

That separation matters. A scout child should feel like a scout, not like Builder wearing a different hat.

### One especially important implementation detail

Delegated child processes intentionally do **not** load `agent-mode` as their own top-level mode selector.

That prevents the child from accidentally snapping back to the parent's main mode persona, model, or thinking level. The child instead runs with the subagent card that the orchestrator selected.

---

## Components and dependencies

The package is easiest to understand as a small stack.

```text
User
  │
  ├─ /mode, /gate, /vars, ~scout
  │
  ▼
agent-mode ─────► pi-gate
  │               │
  │               └─ enforces permissions on tool calls and bash
  │
  ├─ builds the main-agent prompt
  ├─ applies tools/model/thinking
  ├─ records allowed subagents
  │
  ▼
z-prompt-vars
  │
  └─ interpolates ${...} values into the system prompt

Main Pi agent
  │
  ├─ vars tool
  └─ delegate_subagent / delegate_subagent_status
          │
          ▼
subagent-orchestrator
          │
          ├─ reads subagent cards from subagents/
          ├─ manages run state and handbacks
          └─ calls subagent-mode
                    │
                    ▼
              subagent-mode
                    │
                    └─ spawns child pi processes and normalizes events
```

### Component table

| Component | Kind | Main job | User surface | Agent surface | Separate use? |
| --- | --- | --- | --- | --- | --- |
| `extensions/agent-mode` | Extension | Switch the main agent between named modes | `/mode`, shortcuts, footer status | Mode prompt, tool/model/thinking setup | **Yes** |
| `extensions/pi-gate` | Extension | Enforce permission profiles | `/gate`, approvals, footer status | Blocks/asks/allows tool calls | **Yes** |
| `extensions/subagent-orchestrator` | Extension | Manage delegated runs and handbacks | `~scout`, `~generalist`, async run UX | `delegate_subagent`, `delegate_subagent_status` | **Useful, but only with `subagent-mode` and subagent cards** |
| `extensions/subagent-mode` | Extension | Spawn and normalize child runs | None intended for end users | Internal runner/event substrate | **No, mainly internal** |
| `extensions/z-prompt-vars` | Extension | Interpolate prompt vars and manage stored vars | `/vars` | `vars` tool, `${...}` prompt expansion | **Yes** |
| `skills/*` | Skills | Teach the agent how to use the package well | None direct | Skill guidance | **Yes, as instruction assets** |
| `agents/*` | Package asset | Define main modes | Indirect, through `/mode` | Mode instructions/frontmatter | **Only with `agent-mode`** |
| `subagents/*` | Package asset | Define delegated child personas | Indirect, through `~scout` and delegation | Child instructions/frontmatter | **Only with orchestrator + runner** |

### Dependency notes

#### `agent-mode`

- reads mode markdown from `agents/`
- emits gate profile switch events that `pi-gate` can follow
- works best with `z-prompt-vars`, because the built-in modes use `${plan.path}` and `${design.path}`
- can run without `pi-gate`, but then you lose the permission-profile half of the design

#### `pi-gate`

- is the most independently reusable piece
- does not require `agent-mode`
- gains a lot when paired with `agent-mode`, because mode switching can drive profile switching automatically

#### `subagent-orchestrator`

- depends on `subagent-mode` for actual child execution
- depends on package-local `subagents/` cards for delegated persona metadata
- uses mode state from `agent-mode` to know which subagents are allowed
- can also benefit from `z-prompt-vars`, because subagent dispatch defaults live there

#### `subagent-mode`

- is intentionally a substrate, not a polished end-user feature
- is mainly valuable because the orchestrator sits on top of it

#### `z-prompt-vars`

- is independently useful anywhere you want `${...}` prompt interpolation and project/global vars
- becomes especially useful in this package because the built-in modes and workflows refer to plan/design paths and subagent defaults

---

## What is configurable

There are four main configuration layers in this package.

### 1. Agent-mode settings

File:

- `extensions/agent-mode/settings.json`

Current settings:

- `nextShortcut`
- `prevShortcut`

The shipped defaults are:

- `Ctrl+.` for next mode
- `Ctrl+,` for previous mode

### 2. Gate policy

Files:

- `extensions/pi-gate/policy.json`
- `extensions/pi-gate/policy.schema.json`

This controls:

- global/default permission rules
- named profiles
- profile inheritance
- unattended profiles
- subject-specific rules for tools and bash

The shipped policy includes profiles for:

- `builder`
- `planner`
- `designer`
- `code-reviewer`
- `scout`
- `generalist`

### 3. Prompt vars and prompt-vars write config

Files in the consuming workspace/user environment:

- `<cwd>/.pi/agent-mode-vars.json`
- `<cwd>/.pi/agent-mode-vars-config.json`
- `~/.pi/agent/agent-mode-vars.json`

This controls:

- plan/design paths
- project/global custom vars
- where writes go (`project` or `global`)
- the effective vars filename
- the default user-facing subagent dispatch context

Bootstrap seeds the default dispatch context to:

```json
{
  "subagents": {
    "dispatch": {
      "defaultContext": "fresh"
    }
  }
}
```

### 4. Package-local mode and subagent cards

These are the most important authoring surfaces in the package itself.

#### Mode cards in `agents/*.md`

The package currently uses frontmatter like this:

| Field | Meaning |
| --- | --- |
| `name` | Human-facing mode name |
| `description` | Short summary shown in mode info |
| `profile` | The gate profile to activate |
| `color` | Footer/status color |
| `tools` | Active tools for the mode |
| `subagents` | Subagents this mode is allowed to delegate to |
| `bash` | `full` or `read-only` bash policy |
| `thinking` | Preferred thinking level |
| `model` | Preferred model |
| `maxSubagentDepth` | Delegation depth ceiling used by the orchestrator |

The markdown body becomes the mode's main instruction text.

#### Subagent cards in `subagents/*.md`

The orchestrator currently reads these fields from subagent cards:

| Field | Meaning |
| --- | --- |
| `name` | Subagent identifier |
| `description` | Human summary |
| `tools` | Tools enabled for the child |
| `model` | Child model |
| `thinking` | Child thinking level |
| `maxSubagentDepth` | Child delegation depth ceiling |

The markdown body becomes the child system prompt.

### What is configured by the package vs by the workspace

A useful way to think about it is:

#### Package-owned configuration

Lives inside this repository and ships with the package:

- extension code
- skills
- mode cards in `agents/`
- subagent cards in `subagents/`
- gate policy defaults
- default mode navigation settings

#### Workspace/user-owned mutable state

Lives outside the package and should stay mutable:

- prompt-vars files in `.pi/` or `~/.pi/agent/`
- orchestrator runtime state in `.pi/state/subagent-orchestrator/`
- normal Pi session files

That separation is intentional.

---

## Extending agents and subagents

This is one of the most important things to understand about the package: the built-in roles are not magic. They are authored assets.

If you want your own top-level modes, your own delegated specialists, or your own team structure, the main place you extend the system is by editing the markdown cards in:

- `agents/` for main-agent modes
- `subagents/` for delegated child personas

The runtime is designed to read those files and turn them into behavior.

### Where the files live

- main modes: [`agents/`](./agents)
- delegated helpers: [`subagents/`](./subagents)

### How to think about the split

A good rule of thumb is:

- add a file in `agents/` when you want a **top-level operating mode** for the main agent
- add a file in `subagents/` when you want a **delegated helper persona** the main agent can call through the orchestrator

Examples:

- a `Security-Reviewer` or `Docs-Writer` would usually be a new **agent mode**
- a `migration-scout`, `test-runner`, or `api-reviewer` would usually be a new **subagent**

### Extending `agents/`

An agent card defines a main-agent mode.

A minimal mode looks like this:

```md
---
name: Security-Reviewer
description: Review security-sensitive changes with a narrow remit.
profile: code-reviewer
tools: [read, bash, grep, find, ls, delegate_subagent, delegate_subagent_status]
subagents: scout
bash: read-only
thinking: high
model: openai-codex/gpt-5.4
---
Review changes for security issues, dangerous assumptions, and credential exposure.
```

What matters most in practice:

- `name` gives the mode its human-facing identity
- `profile` should line up with a sensible **pi-gate** profile
- `tools` determines what the main agent can actually use in that mode
- `subagents` determines which helpers that mode is allowed to delegate to
- the markdown body is the real heart of the mode; that is where you define the persona, rules, workflow, and tone

#### Tips for writing good mode cards

- make each mode feel like a **distinct job**, not just a slight rewording of another mode
- keep the body focused on mission and behavior, not implementation trivia
- pair the mode with the right gate profile so the permissions reinforce the role
- if you want stable keyboard cycling order, use numbered filenames like `01-builder.md`, `02-planner.md`, and so on
- use `${plan.path}`, `${design.path}`, and other prompt vars when the mode should adapt to the active workspace
- be explicit about whether the mode should implement, plan, design, or review; ambiguity is the enemy here

### Extending `subagents/`

A subagent card defines a delegated child persona.

A minimal subagent looks like this:

```md
---
name: api-reviewer
description: Review API surfaces and contracts for consistency
tools: read, grep, find, ls, bash
model: openai-codex/gpt-5.4-mini
thinking: medium
maxSubagentDepth: 0
---
You are an API reviewer. Inspect route shapes, request and response contracts, validation boundaries, and consistency across handlers.
```

For subagents, the most important currently-used fields are:

- `name`
- `tools`
- `model`
- `thinking`
- `maxSubagentDepth`
- the markdown body

The orchestrator reads those fields and uses them to launch the child with the right runtime.

#### Tips for writing good subagent cards

- make the subagent sharply specialized; broad child personas are usually less helpful than crisp ones
- write the body as if you were briefing a capable teammate for a bounded assignment
- choose a tool set that matches the role instead of defaulting to maximum power
- keep `maxSubagentDepth` low unless the subagent truly benefits from spawning its own helpers
- prefer filenames that match the intended identifier, even though the resolver can also fall back to frontmatter `name`
- think of subagents as **reusable specialists** that the main agent can compose into larger workflows

### How new subagents become usable

Adding a new file to `subagents/` is not enough on its own. A top-level mode must also allow that subagent in its `subagents:` frontmatter.

For example, if you create `subagents/api-reviewer.md`, a mode that should be allowed to call it needs something like:

```md
subagents: scout, api-reviewer
```

That is an intentional safety boundary. It keeps delegation explicit.

### How permissions fit into extensibility

If you add a new agent mode, you will often want a matching or reused profile in:

- `extensions/pi-gate/policy.json`

If you add a new subagent, think carefully about whether its tool set and delegated role should imply a distinct gate profile, a reused one, or tighter constraints.

The main design principle here is that **persona and permission should reinforce each other**.

### A practical way to extend the system

A very workable pattern is:

1. start by cloning the closest existing card
2. change the role name, mission, and tool set
3. simplify rather than elaborate
4. run it in real tasks
5. tighten the body once you see where it drifts

That applies to both modes and subagents.

In other words: do not try to design the perfect specialist from scratch. Start with a clear job and refine it against real use.

---

## Package layout and state locations

### Public package resources

These are exposed to Pi through `package.json`:

- `extensions/`
- `skills/`

### Package-local assets

These are used by the extensions but are not exposed as first-class package entrypoints:

- `agents/`
- `subagents/`

### Important runtime state locations

#### Prompt vars

- project: `<cwd>/.pi/agent-mode-vars.json`
- project config: `<cwd>/.pi/agent-mode-vars-config.json`
- global: `~/.pi/agent/agent-mode-vars.json`

#### Subagent orchestrator runtime state

- `<cwd>/.pi/state/subagent-orchestrator/`

That state includes run metadata, child-session metadata, handbacks, continuations, and logs.

---

## Which parts are reusable on their own

### Good standalone candidates

#### `pi-gate`

If you only want OpenCode-style permissions and profile switching, `pi-gate` is useful by itself.

#### `z-prompt-vars`

If you only want prompt interpolation, plan/design vars, and runtime var storage, `z-prompt-vars` is useful by itself.

#### `agent-mode`

If you want mode switching with different personas, tool sets, and preferred models/thinking levels, `agent-mode` is useful by itself.

It is strongest when paired with `pi-gate`, but it does not strictly require it.

### Best used together

#### `subagent-orchestrator` + `subagent-mode` + `subagents/`

These three form one real feature.

- `subagent-orchestrator` is the public face
- `subagent-mode` is the execution substrate
- `subagents/` holds the child persona definitions

In practice, you should treat them as one subsystem.

### Mostly internal or support assets

#### `subagent-mode`

This exists so the orchestrator can have a clean execution substrate. Most users should not think of it as a standalone feature.

#### `skills/`

These are instruction assets. They matter a lot in practice, but they are not direct end-user UI.

#### `agents/` and `subagents/`

These are authored content assets for the extensions, not independent extension packages.

---

## Further reading

### Component READMEs

- [`extensions/agent-mode/README.md`](./extensions/agent-mode/README.md)
- [`extensions/pi-gate/README.md`](./extensions/pi-gate/README.md)
- [`extensions/subagent-orchestrator/README.md`](./extensions/subagent-orchestrator/README.md)
- [`extensions/subagent-mode/README.md`](./extensions/subagent-mode/README.md)
- [`extensions/z-prompt-vars/README.md`](./extensions/z-prompt-vars/README.md)

### Built-in skills

- [`skills/planning-workflow/SKILL.md`](./skills/planning-workflow/SKILL.md)
- [`skills/orchestrate-subagents/SKILL.md`](./skills/orchestrate-subagents/SKILL.md)
- [`skills/prompt-vars/SKILL.md`](./skills/prompt-vars/SKILL.md)

### Built-in package assets

- [`agents/`](./agents)
- [`subagents/`](./subagents)

---

## Final summary

If you want the shortest accurate mental model, it is this:

- **agent-mode** decides what the main agent is supposed to be
- **pi-gate** decides what it is allowed to do
- **z-prompt-vars** injects project-aware context into prompts
- **subagent-orchestrator** lets the agent call managed helper personas
- **subagent-mode** is the engine that actually runs those helpers
- **`agents/` and `subagents/`** define the shipped personalities
- **`skills/`** teach the agent how to use the whole package well

That combination is what makes `picode` feel less like one generic coding assistant and more like a small, disciplined team with explicit roles.
