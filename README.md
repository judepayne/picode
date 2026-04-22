![picode logo](./img/picode.svg)

A homage to OpenCode in Pi!

![picode preview](./img/picode-preview.png)

`picode` is a Pi package for running Pi with a disciplined, role-based workflow that still feels fast and powerful.

- Switch between **Builder**, **Planner** and **Designer** agents with `Ctrl + ,` and `Ctrl + .`
- Each agent has its own prompt, tools, skills, model settings, allowed subagents and permissions. You are not just telling Pi to “act like a planner.” You are putting it into a runtime that behaves like one.
- An agent is just a markdown file; change as you wish.

- Picode has a sync/ async subagent system.
- Invoke in your chat with the current agent `Fire off a reviewer and have it review index.ts`
- or interact directly `~scout when's the Arsenal match?`
- like agents, subagents are just markdown files so you can extend.

Picode's goal is to give you a significant boost whilst remaining unobtrusive.


**The parts of the whole:**

- **agent-mode** an extension for mode switching and persona prompts
- **pi-gate** an extension for OpenCode-style permission profiles
- **subagent-orchestrator** an extension for mediated delegation to/ monitoring of package-defined subagents
- **subagent-mode** an extension that provides the child-runner substrate behind delegation
- **z-prompt-vars** an extension for prompt interpolation and runtime vars
- **skills** that teach the agent how to use the package well
- **agent-assets** an extension for resolving the built-in and user-overlay agent/subagent cards that define the shipped modes and delegated personas

---

## Contents

- [Install and first run](#install-and-first-run)
- [How picode works](#how-picode-works)
- [The default workflow](#the-default-workflow)
- [Agents](#agents)
- [Subagents](#subagents)
- [Prompt vars and plan/design files](#prompt-vars-and-plandesign-files)
- [Customising picode](#customising-picode)
- [Files and state](#files-and-state)
- [Troubleshooting](#troubleshooting)
- [Further reading](#further-reading)

---

## Install and first run

Install the package:

```bash
pi install npm:@judepayne/picode
```

Reload Pi:

```text
/reload
```

Bootstrap the prompt-vars files:

```text
/vars bootstrap
```

That command creates these project-local files if they do not already exist:

- `<cwd>/.pi/agent-mode-vars.json`
- `<cwd>/.pi/agent-mode-vars-config.json`

It seeds:

- `paths.plan = ".pi/plans/active.md"`
- `paths.design = ".pi/designs/active.md"`
- `subagents.dispatch.defaultContext = "fresh"`
- `pi-location = "project"`

Once that is done, a good quick smoke test is:

```text
/agents
/agents Designer
~scout find every place where config is loaded
```

---

## How picode works

Picode turns one Pi session into a small, structured system.

First, the main agent runs in one of several named **agents** such as Builder, Planner, or Designer. Each agent has its own prompt, tools, preferred model settings, allowed subagents, and permission profile.

Second, permissions are enforced separately from persona through **pi-gate**. That matters. The prompt tells the agent how to behave; the gate tells it what it is allowed to do. In practice, switching agent also switches gate profile, so Builder can be broadly mutating, Planner can be read-mostly, and Designer can be constrained to design artefacts and scratch files.

Pi-gate rules resolve to `allow`, `ask`, or `deny`. For the top-level agents, that gives you a useful balance: permissive where it should be, interactive where it would be risky, and blocked where it should never happen.

Third, the main agent can delegate bounded work to **subagents** such as scout, worker, and reviewer. Those subagents are not role-play. They run from their own markdown cards with their own tools and instructions.

Fourth, prompts can interpolate project-aware values such as the active plan path and design path. That keeps prompts portable and lets the shipped agents adapt to the current workspace without hardcoding absolute paths.

The result is a package that gives Pi more structure without forcing a heavy workflow on top of you.

---

## The default workflow

The default rhythm is simple:

1. **Designer** shapes the approach.
2. **Planner** turns that into a concrete handoff.
3. **Builder** makes the change.
4. **reviewer** checks non-trivial implementation work when needed.

This is not bureaucracy. It is just a way to stop design, planning, implementation, and review from collapsing into one blurry prompt.

If the task is tiny, you can skip straight to Builder. If the task is fuzzy, start with Designer. If the path is clear but the work is still non-trivial, Planner is usually the right next stop.

---

## Agents

Use `/agents` to inspect the current agent and switch between them.

```text
/agents
/agents Designer
/agents Planner
/agents Builder
```

You can also cycle with `Ctrl + ,` and `Ctrl + .`

The shipped agents are:

### Designer

Use Designer when the problem is still taking shape.

Designer is for:
- architecture
- interfaces
- boundaries
- tradeoffs
- shaping the work before code changes

### Planner

Use Planner when you know what should happen and want an implementation-ready handoff.

Planner is for:
- clarifying scope
- sequencing the work
- grounding the plan in the actual repo
- writing the active plan

### Builder

Use Builder when the task is ready to implement.

Builder is for:
- code changes
- focused validation
- using subagents when they genuinely help

A key point: agents are markdown files. If you want a different style, different rules, or a completely different set of roles, you can change them.

The built-in agent definition files live in `extensions/agent-assets/agents/`. Each file is a markdown card with frontmatter for things like the name, tools, gate profile, allowed subagents, model, and thinking level, followed by the body prompt that actually defines the agent’s behaviour.

When you build a new one, keep the role sharp and pair the prompt with the right tools and gate profile; vague overlap between agents tends to blur their behaviour. Also note that the number at the start of the filename sets the order the agents appear in Pi, so files like `01-builder.md`, `02-planner.md`, and `03-designer.md` are shown in that order.

---

## Subagents

Subagents are delegated helpers. The shipped set is:

- `scout` for reconnaissance
- `worker` for bounded implementation or validation work
- `reviewer` for an independent review pass

Like agents, subagents have their own settings: tools, model, thinking level, body prompt, and `maxSubagentDepth`.

You can invoke them directly from the prompt line:

```text
~scout inspect how config is loaded
~worker implement the smallest safe fix and run the relevant test file
~reviewer inspect the current working tree diff and report findings by severity
```

Or you can just ask the current agent to orchestrate the work for you in plain English.

Subagents can run sync or async. Direct `~subagent` use is async and lightweight by design.

They also sit under their own gate profiles. This is where the permission story gets more interesting. The shipped subagent profiles are marked as **unattended**, which means they are designed to run without stopping for interactive `ask` decisions mid-flight. In practice that means the profiles lean toward explicit `allow` or `deny` rules instead.

For example:

- `scout` is tightly read-oriented, can write only to orchestrator artifact locations when needed, and has `maxSubagentDepth: 1`
- `worker` is allowed to mutate files but has sharp denials around things like `git push`, `sudo`, and pipe-to-shell download patterns, and has `maxSubagentDepth: 0`
- `reviewer` is read-only in spirit and does not edit files, with `maxSubagentDepth: 0`

That combination is important: prompt, tools, gate profile, and depth limit all reinforce the intended role.

A few example patterns:

```text
~scout inspect how config is loaded
```

```text
Create a reviewer subagent, run it sync on the current working tree diff, and give me the findings by severity.
```

```text
Spawn three scout subagents in parallel and run them async: one for the API layer, one for persistence, and one for frontend state. Then bring back a concise comparison.
```

```text
Run a sync chain: first scout the parser code path, then have a worker implement the smallest safe fix, then have a reviewer inspect the diff and summarize any remaining risks.
```

Important details:

- `~subagent` must be at the start of the first line
- only subagents allowed by the current agent can be used
- `--fresh`, `--fork`, and `--continue` control delegation context
- the default direct-dispatch context is configured through prompt vars and defaults to `fresh`

Like agents, subagents are just markdown cards. You can add your own specialists instead of forking the runtime.

### Bonus: Going deeper

> [!TIP]
> You could build a PR-management team on top of picode with one custom **team-lead subagent** and one supporting **skill**.
>
> The team lead would own the workflow and delegate the actual work: assess the PR, ask the user for a go/no-go decision, call a Designer subagent if the change needs reshaping, call a Planner subagent to produce the execution plan, fan out multiple Worker subagents by subsystem, then finish with one or more Reviewer subagents.
>
> The skill would define the house process: when each stage starts, what output format each helper must return, when the lead should stop and ask the user, and when it is allowed to continue unattended.
>
> In practice, that means using a chain for the high-level flow and parallel fan-out for the worker/reviewer stages.
>
> The useful trick is that the team lead is itself a subagent, so it can manage a nested team of subagents while still giving the parent run one clean handback at the end.


---

### Monitoring subagents

Picode can surface delegated work in three ways: a quick launch notification, footer status, and optional run cards.

If you launch a subagent directly with `~scout`, `~worker`, or `~reviewer`, you will usually get a short notification such as:

```text
Scout running in background
```

That confirms the launch, but healthy user-started runs do not stay pinned in the footer.

When there is background activity worth tracking, the footer can show compact aggregate status such as:

```text
subagents:1 run
subagents:2 runs: 3 active · 1 waiting
subagents:1 active
subagents:2 active · 1 waiting
```

What those parts mean:

- `run` / `runs` is the number of top-level delegated runs currently in flight
- `active` is the number of child subagents still running
- `waiting` is the number of queued handbacks waiting to be surfaced back to the parent session

Failures stay visible in the footer until your next real user message, so they are hard to miss. Typical examples are:

```text
subagents: failed scout
subagents: failed worker · 1 active
subagents: failed worker · 1 active · 1 waiting
subagents: failed 2 scouts, 1 worker
```

That is usually your cue to ask the main agent to inspect the failure, for example:

```text
Investigate the failed worker.
A scout failed. Find out why and tell me whether to retry it.
```

If picode shows a detailed subagent status card in the chat, that card gives you a closer look at one selected child run. It can show what task that child is working on, whether the overall run is sync or async, how many children are still active or already finished, what tool the child is using right now, where its session/log files live, any recent output, whether handbacks are waiting, and the final summary once the run is done.


I wrestled with adding a pop up monitoring panel for subagents, but instead opted to create extensive 'under the cover' monitoring tools in the subagent-orchestrator extension that the agent can use to investigate on your behalf.

---

## Prompt vars and plan/design files

Picode uses `z-prompt-vars` so prompts can refer to project-aware values such as:

- `${plan.path}`
- `${design.path}`
- `${plan.exists}`
- `${design.exists}`

By default those paths resolve to:

- `.pi/plans/active.md`
- `.pi/designs/active.md`

The vars system reads project values first and global values second, so workspace overrides win.

Useful commands:

```text
/vars
/vars bootstrap
/vars plan.path
/vars set project.name "My Project"
/vars location
/vars location global
```

For most users, `/vars bootstrap` is enough to get started.

---

## Customising picode

There are three main ways to customise the package.

### 1. Edit or add agent cards

Built-in agent cards live under:

- `extensions/agent-assets/agents/`

These define top-level agents such as Builder, Planner, and Designer.

### 2. Edit or add subagent cards

Built-in subagent cards live under:

- `extensions/agent-assets/subagents/`

These define delegated specialists such as scout, worker, and reviewer.

### 3. Add user overlays

Instead of editing the shipped package files directly, you can point picode at your own overlay directories through Pi settings.

In `.pi/settings.json` or `~/.pi/agent/settings.json`:

```json
{
  "picode": {
    "agentsDir": "./custom-agents",
    "subagentsDir": "./custom-subagents",
    "agentsOnConflict": "prefer-user",
    "subagentsOnConflict": "prefer-user"
  }
}
```

That lets you keep your own house style while still using the rest of the package.

The conflict policy settings control what happens when a user overlay file has the same filename as a built-in one:

- `prefer-user` means your overlay file wins and shadows the shipped file
- `prefer-native` means the shipped file stays active and the conflicting user file is ignored

That can be useful if you want to allow additive custom files in an overlay directory without accidentally replacing the built-in cards.

---

## Files and state

The files in this repository define how picode behaves. The files picode creates while you use it live in your project’s `.pi/` directory or in your normal Pi user config area.

### Package-owned

Inside the package:

- `extensions/`
- `skills/`
- `extensions/agent-assets/agents/`
- `extensions/agent-assets/subagents/`

### Workspace/user-owned

Outside the package:

- project prompt vars: `<cwd>/.pi/agent-mode-vars.json`
- project prompt-vars write config: `<cwd>/.pi/agent-mode-vars-config.json`
- global fallback prompt vars: `~/.pi/agent/agent-mode-vars.json`
- subagent orchestrator state: `<cwd>/.pi/state/subagent-orchestrator/`
- Pi session files in Pi’s normal session storage

That split is deliberate: shipped behaviour stays package-owned, while mutable project state stays local to the workspace or user environment.

---

## Troubleshooting

### I installed the package but nothing changed

Run `/reload`, or restart Pi if you installed the package outside the current running session.

### `/agents` is not available

Check that the package installed successfully with `pi list`, then reload.

### `~scout` or another subagent is not available

Make sure the current agent is allowed to delegate to that subagent.

### My local edits are not showing up during development

Use a local-path install and run `/reload` after editing files in this repository.

### My overlay cards are not being picked up

Check the `picode` block in `.pi/settings.json` or `~/.pi/agent/settings.json` and confirm the configured directories actually exist.

### Where are release notes?

See [`CHANGELOG.md`](./CHANGELOG.md).

---

## Further reading

- [`extensions/agent-mode/README.md`](./extensions/agent-mode/README.md) — read this to understand how agent switching works: prompts, tools, models, thinking levels, shortcuts, and the `/agents` command.<br><br>
- [`extensions/pi-gate/README.md`](./extensions/pi-gate/README.md) — read this to understand the permission system: profiles, `allow`/`ask`/`deny`, inheritance, and how bash/file actions are gated.<br><br>
- [`extensions/subagent-orchestrator/README.md`](./extensions/subagent-orchestrator/README.md) — read this to understand the public delegation layer: `~subagent`, sync vs async runs, chains, parallel fan-out, status, logs, and handbacks.<br><br>
- [`extensions/subagent-mode/README.md`](./extensions/subagent-mode/README.md) — read this if you want the internal execution model behind subagents: child `pi` processes, normalized events, sync/async executors, and depth propagation.<br><br>
- [`extensions/z-prompt-vars/README.md`](./extensions/z-prompt-vars/README.md) — read this to learn how `${...}` prompt interpolation works, where vars are stored, and how `/vars` reads and writes project/global state.<br><br>
- [`extensions/agent-assets/README.md`](./extensions/agent-assets/README.md) — read this to understand where built-in agent/subagent cards come from, how overlays are resolved, and what `prefer-user` / `prefer-native` actually do.<br><br>
- [`skills/planning-workflow/SKILL.md`](./skills/planning-workflow/SKILL.md) — read this to see the planning discipline shipped with picode: how a request is turned into a Builder-ready plan grounded in the repo.<br><br>
- [`skills/karpathy-coding-discipline/SKILL.md`](./skills/karpathy-coding-discipline/SKILL.md) — read this to see the Builder’s coding discipline layer: it pushes toward caution over speed, simpler changes, explicit assumptions, and tighter validation loops.<br><br>
- [`skills/orchestrate-subagents/SKILL.md`](./skills/orchestrate-subagents/SKILL.md) — read this to see how the agent is taught to choose between one subagent, several in parallel, or a chain, and when to run sync vs async.<br><br>
- [`skills/prompt-vars/SKILL.md`](./skills/prompt-vars/SKILL.md) — read this to see how prompt vars are meant to be used in prompts and at runtime, including the built-in plan/design vars and write-location rules.

---

Jude Payne, 2026. License MIT
