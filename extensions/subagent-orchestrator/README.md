# subagent-orchestrator

`subagent-orchestrator` is the public delegation layer in `picode`.

It is the part that turns delegated work into a managed feature instead of just a blind child process spawn.

It decides:

- which subagents are allowed
- how requests are normalized
- how sync and async work are handled
- how async work is tracked
- how results are handed back
- how logs, trees, streams, and cancellation work

If `agent-mode` answers "what should the main agent be right now?", then `subagent-orchestrator` answers:

> If the main agent needs help, how should that help be launched, constrained, and surfaced back?

---

## What it does

`subagent-orchestrator` provides two agent-facing tools:

- `delegate_subagent`
- `delegate_subagent_status`

It also provides a user-facing shorthand for async delegation:

- `~scout ...`
- `~worker ...`

Internally, it:

- reads the current mode state to see which subagents are allowed
- reads subagent metadata from `subagents/*.md`
- launches work through `subagent-mode`
- stores run state under `.pi/state/subagent-orchestrator/`
- manages handbacks, continuations, and run UI state

---

## User surface

### Prompt-line shorthand

The most direct user-facing surface is the `~subagent` shorthand at the start of an interactive prompt line.

Examples:

```text
~scout find every place where Zod schemas are constructed in this repo
~scout --fresh compare how configuration is loaded in the CLI and the server
~scout --fork use the current debugging conversation and identify the strongest root-cause candidates
~scout --cont pick up the earlier scout thread and check the parser next
~worker implement the smallest safe fix for the failing parser test and run the relevant test file
```

This is the fast, high-leverage way to kick off helper work without needing the parent agent to translate your request first.

Important rules:

- it only works at the start of the first line
- it only works in interactive input
- it only works for subagents allowed by the current mode
- every run launched this way is **asynchronous**
- `--fresh`, `--fork`, and `--continue` (or `--cont`) override the context for that run
- `continue` reuses the same user-facing subagent conversation for the current parent conversation when available
- if that continued thread is already active, you get a short `scout is busy` style message instead of starting a second concurrent continued thread
- continued user subagent context is in-memory only and resets on reload or restart

### What this feels like in practice

A good mental model is that `~scout` is your quick “go investigate this and come back” lever, while `~worker` is your quick “go do this piece of work autonomously” lever.

That makes the feature feel less like a low-level spawn primitive and more like having a small bench of helpers you can send out to do focused work while you keep moving.

### Status surfaces

The orchestrator can show:

- footer/status activity for delegated runs
- queued handbacks
- optional visible run cards
- surfaced completion handbacks once async work finishes

In the healthy case, the footer stays intentionally quiet and aggregate. Direct user `~scout` and `~worker` launches get an immediate notification such as `Scout running in background`, but healthy user-addressed runs do not stay pinned in the footer.

When a **main-agent-triggered** delegated run fails, the footer keeps a concise failure summary visible. Examples:

- `subagents: failed scout`
- `subagents: failed worker`
- `subagents: failed 2 scouts, 1 worker`
- `subagents: failed worker · 1 active`

That summary is meant to prompt the next conversation rather than turn the user into an orchestrator operator. In practice, the normal next step is simply to ask the main agent to investigate, for example:

> Investigate the failed worker.

The failure summary persists until the next real user message, which acts as an acknowledgment.

So even when delegated work is happening in the background, it does not have to disappear into a black box. The orchestrator keeps enough UI state around that runs can be inspected, resumed, and surfaced cleanly, while the main agent remains the normal investigation interface.

---

## Instructing the agent

You do not have to use the `~subagent` shorthand directly.

A lot of the time, the more natural way to use this extension is simply to ask the main agent to create delegated work for you. When the package skill support is loaded, the agent can decide whether a subagent job should be **synchronous** or **asynchronous**, whether it should run as a **single task**, a **parallel fan-out**, or a **chain**, and which subagent persona is the best fit.

The main skill to look at here is:

- [`skills/orchestrate-subagents/SKILL.md`](../../skills/orchestrate-subagents/SKILL.md)

That skill teaches the main agent how to think about delegation mechanics instead of forcing every prompt author to rediscover them from scratch.

### Examples of things a user might say

A simple reconnaissance request:

> Create a scout subagent to find every place where `<LibraryX>` is used and group the results by subsystem.

A focused parallel investigation:

> Spawn three scout subagents in parallel and run them async: one should review the API layer, one the persistence layer, and one the frontend state layer for code-quality risks. Then bring back a concise comparison of the most important issues.

A chained implementation-support workflow:

> Create an async chain of worker subagents. First, review `ModuleX` for code quality and maintainability issues. Second, apply the smallest safe cleanup for the highest-value issue. Third, summarize exactly what changed, what improved, and what follow-up work still remains.

A context-sensitive debugging request:

> Fork from the current conversation and launch a scout subagent to use the debugging context we already built up, then tell me the most likely root cause and the strongest supporting evidence.

A mixed planning request:

> Use a scout to map the affected code paths, then if the findings are broad, fan out into parallel scouts for the most suspicious areas and return a synthesized summary.

### Sync and async

Subagent jobs can be launched either **synchronously** or **asynchronously**.

#### Synchronous
Use sync when you want the parent agent to wait and continue the same turn with the delegated result.

This is best for:

- short reconnaissance
- quick supporting checks
- compact transformations where the parent should synthesize immediately

#### Asynchronous
Use async when you want the delegated work to continue in the background and hand back later.

This is best for:

- broader codebase sweeps
- long-running implementation work
- parallel fan-out
- anything where waiting inline would interrupt the parent agent's flow

The prompt-line shorthand is always async. Agent-to-tool delegation can be either sync or async.

### Nested teams and max depth

Subagents can themselves delegate to subagents.

That is powerful, but it needs a safety rail. This package uses **max subagent depth** to cap how deep nested delegation can go.

In practice, that means you can build patterns like:

- a parent Builder delegating to a scout
- that scout delegating to more helpers for narrower follow-up investigation
- a worker coordinating a short internal chain before returning a result

But the nesting is still bounded, so you do not end up with runaway recursive delegation.

This is especially useful if you want to build your own higher-level workflows or skills on top of the library. For example, you could create a skill that assembles a nested team of specialists: one scout for architecture mapping, one implementation-oriented worker, one review-oriented helper for targeted verification, all operating under a controlled depth ceiling.

That is where `subagent-orchestrator` starts to feel less like a single feature and more like a foundation for richer multi-agent patterns.

---

## Agent surface

### `delegate_subagent`

This is the main agent-facing delegation API.

It supports three shapes:

- single task
- parallel tasks
- chain of tasks

It also supports both sync and async launches, so the parent agent can either wait for the result inline or dispatch it into the background.

Examples:

#### Single

```ts
await delegate_subagent({ task: "Inspect the parser and return the likely root cause." })
```

#### Single with explicit subagent

```ts
await delegate_subagent({
  agent: "worker",
  task: "Apply the smallest safe fix for the failing parser test and run the targeted validation."
})
```

#### Parallel

```ts
await delegate_subagent({
  agent: "scout",
  async: true,
  tasks: [
    { task: "Inspect API-layer validation and note weak spots." },
    { task: "Inspect persistence-layer validation and note weak spots." },
    { task: "Inspect frontend form validation and note weak spots." }
  ]
})
```

#### Chain

```ts
await delegate_subagent({
  agent: "worker",
  async: true,
  chain: [
    { task: "Review ModuleX for the highest-value maintainability issue." },
    { task: "Apply the smallest safe fix for that issue." },
    { task: "Summarize what changed, what improved, and any remaining follow-up." }
  ]
})
```

### Context modes

Delegated runs can be launched with:

- `fresh`
- `fork`
- `continue`

#### `fresh`
A clean child session. This is the normal default and the recommended choice for most delegation.

#### `fork`
A branched child session that inherits the current conversation context. Use this only when the child truly needs that prior context.

#### `continue`
Reuse the same delegated user-facing subagent conversation for follow-up `~subagent` messages in the current parent conversation. This is mainly for direct user dispatch rather than general agent orchestration.

### `delegate_subagent_status`

This is the inspection and control API for delegated runs.

Actions include:

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

Use it when the agent needs to inspect or control a run rather than merely wait for the handback.

---

## Subagent cards

The orchestrator reads subagent definitions from `subagents/*.md`.

Those cards currently define the child persona through:

- `model`
- `thinking`
- `tools`
- `maxSubagentDepth`
- markdown-body instructions

That means the orchestrator does not just launch a generic child process and hope for the best. It launches a specific persona.

For example, a `scout` child uses the scout card's own instructions, tools, model, and thinking level.

---

## Dependencies

### Hard dependency: `subagent-mode`

`subagent-orchestrator` does not execute children by itself. It depends on `subagent-mode` as the runner substrate.

### Uses current mode state from `agent-mode`

The orchestrator reads the current top-level mode state to decide which subagents are allowed.

### Benefits from `z-prompt-vars`

The user-facing `~subagent` shorthand reads the default dispatch context from prompt vars. This package seeds that default to `fresh`, but you can also set it to `continue` when you want repeated direct user follow-ups to stay in the same delegated thread until reload or shutdown.

### Child runtime composition

Delegated children are launched with an explicit child extension set that includes the pieces they need, such as:

- `pi-gate`
- `subagent-mode`
- `subagent-orchestrator`
- `z-prompt-vars`

Notably, child processes do **not** load `agent-mode` as a top-level mode switcher. That keeps subagents aligned to their subagent cards instead of inheriting the parent main-agent mode.

---

## Standalone usefulness

`subagent-orchestrator` is reusable, but not meaningfully by itself.

Treat it as one subsystem with:

- `subagent-mode`
- package-local `subagents/`
- ideally `agent-mode` and `pi-gate`

If you only load the orchestrator without its runner or without subagent cards, you do not really have the full feature.

---

## Runtime state

The orchestrator stores its working state under:

```text
<cwd>/.pi/state/subagent-orchestrator/
```

That state includes things like:

- runs
- child session records
- handbacks
- continuations
- node logs
- indexes used for status and recovery

This makes async delegation observable and resumable instead of purely ephemeral.
