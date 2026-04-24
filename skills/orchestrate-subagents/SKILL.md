---
name: orchestrate-subagents
description: Use mediated subagent delegation through delegate_subagent and delegate_subagent_status. Use when deciding whether to run one scout, multiple scouts, or a scout chain, and when choosing sync vs async or fresh vs fork vs explicit continue context.
---

# Orchestrate Subagents

## Purpose

Use this skill when you need to delegate investigation work to subagents through the local orchestrator tools.

Current orchestrator constraints:
- only the mediated tools are supported:
  - `delegate_subagent`
  - `delegate_subagent_status`
- raw `subagent` is not the interface here
- the available child agent types depend on the current mode; use only the subagents explicitly allowed by that mode
- child gate profile/env is assigned by the orchestrator, not by you
- child runs are unattended, so `clarify` is not available
- agent-driven continuation is explicit: use `context: "continue"` together with a concrete `childSessionId`
- for current or recent async work, use the orchestrator status tool rather than digging through files on disk
- read async artifacts on disk only for older runs outside the current/latest tree, or for low-level debugging

## Tool surface

### `delegate_subagent`

You may call exactly one of these shapes:

```json
{ "task": "...", "async": false, "context": "fresh", "showRunCard": false }
```

```json
{ "tasks": [{ "task": "..." }, { "task": "..." }], "async": false, "context": "fresh", "showRunCard": false }
```

```json
{ "chain": [{ "task": "..." }, { "task": "..." }], "async": false, "context": "fresh", "showRunCard": false }
```

Supported top-level options:
- `agent` — optional subagent type; defaults to `scout` when omitted
- `task` — one subagent
- `tasks` — multiple subagents in parallel
- `chain` — multiple subagents in sequence
- `async` — background execution when `true`
- `timeoutSeconds` — optional timeout for synchronous delegated runs; defaults to 180 seconds. Async runs do not use it, but if you provide it anyway it still must be a valid positive integer within the supported range.
- `context` — `fresh`, `fork`, or `continue`
- `childSessionId` — required when `context` is `continue`; identifies the exact delegated child session to resume
- `showRunCard` — visible orchestrator run card message; keep this `false` unless the user explicitly wants that UI card

Not available:
- no raw env/profile control
- no `cwd`
- no `clarify`
- no implicit agent-side `continue latest`; agent continuation must name the target `childSessionId`

### `delegate_subagent_status`

Use one of:

```json
{ "action": "list" }
```

```json
{ "action": "get", "runId": "..." }
```

```json
{ "action": "cancel", "runId": "..." }
```

```json
{ "action": "tree" }
```

```json
{ "action": "tree", "runId": "..." }
```

```json
{ "action": "log", "childSessionId": "..." }
```

```json
{ "action": "stream", "childSessionId": "..." }
```

```json
{ "action": "stream_next", "childSessionId": "...", "cursor": "..." }
```

Optional for `log`, `stream`, and `stream_next`:

```json
{ "includeThinking": true }
```

Also still available for direct-child focus in existing status views:

```json
{ "action": "next", "runId": "..." }
```

```json
{ "action": "prev", "runId": "..." }
```

```json
{ "action": "select", "runId": "...", "childIndex": 0 }
```

Use this for async work after launch, and for monitoring active delegated trees.

Behavior summary:
- `tree` returns the current/latest delegated tree for the current mode by default
- `tree(runId)` inspects an explicit run within the current mode
- `log(childSessionId)` returns the full node history
- `stream(childSessionId)` is follow-only from now and returns `null` for terminal nodes
- `stream_next(childSessionId, cursor)` returns only new appended records plus the next cursor
- thinking is hidden by default; opt in with `includeThinking: true`
- older runs beyond the current/latest tree may require direct disk inspection

## Choosing task vs tasks vs chain

### Use `task`
Use one scout when the question is focused and the answer can come from one investigation path.

Examples:
- find the key files for a subsystem
- summarize the current auth flow
- inspect where a feature flag is enforced

### Use `tasks`
Use multiple scouts in parallel when the work can be split into independent investigations.

Examples:
- scout the frontend, backend, and infra separately
- inspect three candidate modules in parallel
- compare different implementation areas quickly

Good parallel decomposition:
- each task should stand on its own
- each scout should have a distinct area or question
- avoid overlap unless you intentionally want independent perspectives

### Use `chain`
Use a chain when later scout steps should build on earlier scout output.

Examples:
- first scout gathers entry points, second scout follows those paths deeper
- first scout maps architecture, second scout inspects edge cases revealed by the map

Use a chain when order matters.

## Choosing sync vs async

### Prefer sync
Use sync when:
- you want the findings in the current turn
- the investigation is moderate in size
- you need to synthesize the result immediately
- the default 180-second timeout is likely to be sufficient, or you deliberately set a longer `timeoutSeconds`

### Prefer async
Use async when:
- the investigation is broad or time-consuming
- you want the main conversation to continue without waiting
- you want to queue background scouting and come back later
- a sync timeout would be wasteful or likely to trip even with a longer `timeoutSeconds`

When `async: true`:
- set `showRunCard: false` unless the user explicitly asks for the visible run card
- the tool returns immediately with an orchestrator run id
- later inspect it with `delegate_subagent_status`
- use `tree` when you want the whole descendant view
- use `log` when you want the full history for one node
- use `stream` plus `stream_next` when you want to poll live follow updates for one node
- completion is surfaced back into the conversation as an orchestrator-owned completion payload
- do not restate the async launch in the assistant reply if the tool result already shows that it started
- prefer no assistant text at all after the async launch tool call; wait for completion
- when the completion payload arrives, use it like sync delegated results and answer the original request naturally

## Choosing `fresh` vs `fork`

### `context: "fresh"`
Choose `fresh` when you want the scout to work from a clean context and rely only on the delegated task plus files it reads.

Prefer `fresh` for:
- broad codebase scans
- neutral investigation
- avoiding unnecessary conversational baggage

### `context: "fork"`
Choose `fork` when the current conversation branch contains important live context the scout should inherit.

Prefer `fork` for:
- investigations tied tightly to the current thread
- follow-up exploration of a design or implementation already discussed in detail
- situations where the current branch context is part of the task

!NOTE: Only use fork when strictly necessary! Since subagents are often configured to use different (lesser) models than the main agent models, `fork` will require the current context to be processed with no caching on that different model. This can take up time and use up a lot of tokens!

### `context: "continue"`
Choose `continue` when you want to resume one exact delegated child conversation rather than start a fresh or forked child.

Rules:
- use it only with single-task delegation
- always supply `childSessionId`
- get the target id from prior orchestration details or from `delegate_subagent_status`
- prefer this for staged workflows with explicit checkpoints, where the parent agent resumes the same specialist after a user decision

## Working pattern

1. Decide whether you need one subagent, parallel subagents, or a chain.
2. Decide whether results are needed now or can run in the background.
3. Decide whether the subagent should run in `fresh`, `fork`, or explicit `continue` context.
4. Choose the subagent type if the current mode allows more than one.
5. Call `delegate_subagent`.
6. If async, note the returned run id and monitor with `delegate_subagent_status`.
7. Prefer `tree` / `log` / `stream` / `stream_next` for active monitoring instead of reading files directly.
8. If the delegation fails, inspect the failure reason before deciding what to do next.
9. If it failed due to a timeout, decide whether the right next step is a longer `timeoutSeconds` or an async rerun.
10. Synthesize the findings back into the main answer.

## Interpreting orchestrator status and completion messages

Important:
- lines like `Delegated run <id>: running` or `Delegated run <id>: complete` are orchestrator-generated runtime state, not user-authored messages
- do not say or imply that the user “posted”, “said”, or “told you” those lines
- treat them as system/runtime context unless the user explicitly asks about that run

When a background completion triggers a follow-up turn:
- recognize that the turn was triggered by the orchestrator handing back a finished child result
- do not frame it as uncertainty about what the user meant
- do not start by speculating that the user might be asking for status
- if the child result already satisfies the original request, answer directly and briefly

## Avoiding unnecessary status checks

- `delegate_subagent_status` is mainly for async work and explicit inspection asks
- after a successful sync `delegate_subagent` call, do not call `delegate_subagent_status` to re-check the same run; the final result is already present
- if an orchestrator completion/handback message is already present, do not immediately poll status again unless you need extra metadata or tree/log/stream details
- prefer `tree` when you need the live descendant structure
- prefer `log` when you need a full per-node replay
- prefer `stream` and `stream_next` when you need live follow behavior without replaying backlog
- do not dig through async files on disk for current/latest work unless the orchestrator surface is insufficient or you are debugging persistence

## Presenting child output

The user wants to see the scout's output in your reply. The orchestrator renders handback content in its own card, but treat that as supplementary — you are still responsible for delivering the answer in your own assistant message. Default to presenting the content, not pointing at it.

- when the user asked for a specific artifact (a poem, a summary, a list of files, a recommendation), include that artifact in your reply
- you may reproduce the child's output verbatim when the user asked for exactly that (e.g. "write me a poem" → show the poem), or synthesize / combine when the user asked for analysis across multiple scouts
- do not reply with "the result is above" or "the poem is above" — the user is reading your message, not hunting for a card
- keep the reply focused: surface the artifact plus any brief framing; don't pad with restated status or meta-commentary
- do not restate stale intermediate status unless it is materially helpful

## Response patterns

### Sync direct-result request
After a sync `delegate_subagent` call:
- present the child's output in your reply (verbatim for artifact requests, synthesized for analytical requests)
- avoid extra status polling
- no need to restate that the subagent "ran" or "finished" — just answer

### Sync failure handling
If a sync `delegate_subagent` call fails:
- inspect the failure reason rather than treating all failures the same
- if the failure was a timeout, consider rerunning with a longer `timeoutSeconds`
- if the work looks inherently long-running, prefer rerunning async instead of stretching sync indefinitely
- explain the next step you chose briefly and concretely

### Async completion turn
If a background handback or continuation arrives:
- treat it as orchestrator-generated completion context
- answer as a completion follow-up, not as a new user request
- avoid phrasing like "it seems the user posted something related to status"
- present the child's output the same way you would a sync result — include the artifact, don't just acknowledge
- synthesize, combine, or transform the child outputs when the user asked for analysis
- if completion has already arrived, skip any pending launch acknowledgment

### Status line without an explicit user ask
If you only see an orchestrator status line:
- do not assume the user wants a status explanation
- only inspect with `delegate_subagent_status` when you need the details to complete the task or answer an explicit question

## Examples

### Single scout, sync
```json
{
  "task": "Inspect the repository and identify the main modules involved in authentication.",
  "context": "fresh",
  "async": false
}
```

### Parallel scouts, sync
```json
{
  "tasks": [
    { "task": "Inspect the frontend auth entry points and summarize the main files." },
    { "task": "Inspect the backend auth services and summarize the main files." },
    { "task": "Inspect configuration, secrets handling, and environment wiring for auth." }
  ],
  "context": "fresh",
  "async": false
}
```

### Scout chain, sync
```json
{
  "chain": [
    { "task": "Map the main package boundaries and identify the most relevant modules for the feature." },
    { "task": "Using the earlier findings, inspect the most relevant module boundaries for coupling and extension points." }
  ],
  "context": "fork",
  "async": false
}
```

### Async launch
```json
{
  "tasks": [
    { "task": "Inspect the UI composition points for the feature." },
    { "task": "Inspect the data flow and state management for the feature." }
  ],
  "context": "fork",
  "async": true
}
```

### Later status check
```json
{ "action": "list" }
```

```json
{ "action": "get", "runId": "<returned-run-id>" }
```

### Inspect the current delegated tree
```json
{ "action": "tree" }
```

### Inspect a node log
```json
{ "action": "log", "childSessionId": "<child-session-id>" }
```

### Follow a live node stream
```json
{ "action": "stream", "childSessionId": "<child-session-id>" }
```

```json
{ "action": "stream_next", "childSessionId": "<child-session-id>", "cursor": "<cursor-from-stream-or-stream_next>" }
```

### Cancel a background run
```json
{ "action": "cancel", "runId": "<returned-run-id>" }
```

## Guidance for synthesis

After the scouts return:
- merge overlapping findings
- call out conflicts or uncertainty explicitly
- keep exact file names and line ranges when useful
- turn reconnaissance into a clear recommendation or next-step design insight
