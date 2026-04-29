---
name: orchestrate-subagents
description: Use mediated subagent delegation through delegate_subagent and delegate_subagent_status. Use when deciding whether to delegate at all, and when choosing sync vs async, task vs tasks vs chain, and fresh vs fork vs explicit continue context.
---

# Orchestrate Subagents

## Purpose

Use this skill when you are considering delegated work through the local orchestrator tools.

The orchestrator is useful, but delegation has a coordination cost. First decide whether separation actually helps. If it does, decide how to delegate.

## When to delegate

Use a subagent only when the task has a clear boundary and separation provides a concrete benefit.

Good reasons to delegate:
- **Parallelism**: independent areas can be investigated, implemented, validated, or compared at the same time.
- **Async progress**: broad or slow work can continue in the background instead of blocking the conversation.
- **Role specialism**: a `reviewer` can provide read-only critique focused on correctness, regressions, security, and maintainability.

Do the work yourself when it is small, sequential, needs clarification, depends on nuanced user intent, or is mainly synthesis and judgement. Do not delegate merely because a `scout` or `worker` could perform the same steps; without parallelism or async progress, the handoff overhead is usually not worth it.

The parent keeps final accountability. Subagents gather evidence, perform bounded parallel/background work, or review; the parent decides what it means and answers the user.

## First how-choice: sync vs async

After deciding to delegate, choose whether the result is needed in this turn.

Prefer **sync** when the delegated task is bounded and you need the result before answering. Sync is best for small fan-outs, focused reviewer passes, and investigations where the default 40-second inactivity timeout is likely to be enough. If needed, set a longer `timeoutSeconds` deliberately.

Prefer **async** when the delegated task is broad, slow, long-running, or useful to start while the conversation continues. Long-running work is only a delegation reason when async progress helps; a long sync subagent often just moves the waiting elsewhere.

When `async: true`, do not add an assistant launch acknowledgment if the tool result already shows the run started. Wait for the orchestrator completion payload, then answer the original request naturally.

## Current orchestrator constraints

- Use only the mediated tools: `delegate_subagent` and `delegate_subagent_status`.
- Do not use raw `subagent` here.
- Available child agent types depend on the current mode; use only subagents explicitly allowed by that mode.
- Child gate profile/env is assigned by the orchestrator, not by you.
- Child runs are unattended, so `clarify` is not available.
- Agent-driven continuation is explicit: use `context: "continue"` with a concrete `childSessionId`.
- For current or recent async work, use the orchestrator status tool rather than digging through files on disk.
- Read async artifacts on disk only for older runs outside the current/latest tree, or for low-level debugging.

## Choosing the subagent type

Use the subagent type that matches the actual reason for delegation.

- `scout`: reconnaissance when the work is parallelized, broad enough to benefit from async, or part of a chain that deliberately narrows a large search space.
- `worker`: bounded implementation or validation when the current mode allows it and the work can run in parallel or in the background.
- `reviewer`: independent read-only critique of a design, plan, diff, or working tree. This is the main role-specialist subagent.

Do not use a scout or worker just to avoid doing ordinary parent-agent work. If the parent can inspect, decide, or edit directly with less coordination overhead, keep the work in the parent.

## Choosing task vs tasks vs chain

Use `task` for one bounded delegation, especially one reviewer pass, one async scout, or one explicit `continue` resume.

Use `tasks` for parallel work. Each task should stand on its own, have a distinct area or question, and avoid overlap unless the overlap is intentional.

Use `chain` when later steps should build on earlier child output. Prefer `tasks` when the work is independent.

Examples:
- `task`: review the current working tree diff.
- `tasks`: inspect frontend, backend, and configuration separately.
- `chain`: first map entry points, then inspect the most relevant paths.

## Choosing context

Use `context: "fresh"` when the child should work from a clean context and rely only on the delegated task plus files it reads. Prefer this for broad scans, neutral investigation, and avoiding unnecessary conversational baggage.

Use `context: "fork"` only when the current conversation branch contains important live context the child must inherit. Fork sparingly: subagents may use different models than the parent, and forking can require the current context to be processed without cache on that model, which can be slow and token-heavy.

Use `context: "continue"` when resuming one exact delegated child conversation. Use it only with single-task delegation, always supply `childSessionId`, and get that id from prior orchestration details or `delegate_subagent_status`.

## Tool reference

### `delegate_subagent`

Call exactly one of these shapes:

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
- `timeoutSeconds` — optional inactivity timeout for synchronous delegated runs; defaults to 40 seconds without child activity. Async runs do not use it, but if you provide it anyway it must still be valid.
- `context` — `fresh`, `fork`, or `continue`
- `childSessionId` — required when `context` is `continue`
- `showRunCard` — visible orchestrator run card message; keep this `false` unless the user explicitly wants that UI card

Not available: raw env/profile control, `cwd`, `clarify`, or implicit agent-side `continue latest`.

### `delegate_subagent_status`

Use this for async work after launch, and for monitoring active delegated trees. Common calls:

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

Also available for direct-child focus in existing status views: `next`, `prev`, and `select` with `runId`; `select` also takes `childIndex`.

Behavior summary:
- `tree` returns the current/latest delegated tree for the current mode by default.
- `tree(runId)` inspects an explicit run within the current mode.
- `log(childSessionId)` returns the full node history.
- `stream(childSessionId)` is follow-only from now and returns `null` for terminal nodes.
- `stream_next(childSessionId, cursor)` returns only new appended records plus the next cursor.
- Thinking is hidden by default; opt in with `includeThinking: true`.
- Older runs beyond the current/latest tree may require direct disk inspection.

## Working pattern

1. Decide whether delegation is justified at all.
2. Choose sync or async.
3. Choose one task, parallel tasks, or a chain.
4. Choose `fresh`, `fork`, or explicit `continue` context.
5. Choose the subagent type if the current mode allows more than one.
6. Call `delegate_subagent`.
7. If async, use `delegate_subagent_status` only when you need to inspect, monitor, or cancel the run.
8. If delegation fails, inspect the failure reason before deciding what to do next.
9. If sync failed due to inactivity timeout, decide whether the next step is a longer `timeoutSeconds`, an async rerun, or doing the work yourself.
10. Synthesize the findings back into the main answer.

## Interpreting orchestrator status and completion messages

Lines like `Delegated run <id>: running` or `Delegated run <id>: complete` are orchestrator-generated runtime state, not user-authored messages. Do not say or imply that the user posted, said, or told you those lines.

When a background completion triggers a follow-up turn, treat it as orchestrator-generated completion context. Answer as a completion follow-up, not as a new user request. Do not speculate that the user might be asking for status. If the child result satisfies the original request, answer directly and briefly.

## Avoiding unnecessary status checks

- `delegate_subagent_status` is mainly for async work and explicit inspection asks.
- After a successful sync `delegate_subagent` call, do not call `delegate_subagent_status` to re-check the same run.
- If an orchestrator completion/handback message is already present, do not immediately poll status again unless you need extra metadata or tree/log/stream details.
- Prefer `tree` for the live descendant structure, `log` for a full per-node replay, and `stream` / `stream_next` for live follow behavior without replaying backlog.
- Do not dig through async files on disk for current/latest work unless the orchestrator surface is insufficient or you are debugging persistence.

## Presenting child output

The orchestrator renders handback content in its own card, but treat that as supplementary. You are still responsible for delivering the answer in your own assistant message.

When the user asked for a specific artifact, include it in your reply. You may reproduce child output verbatim when the user asked for exactly that, or synthesize/combine it when the user asked for analysis across multiple children. Do not reply with "the result is above"; the user is reading your message, not hunting for a card.

## Response patterns

### Sync direct-result request

After a sync `delegate_subagent` call, present the child output in your reply. Use it verbatim for artifact requests and synthesize it for analytical requests. Do not add status polling.

### Sync failure handling

If a sync `delegate_subagent` call fails, inspect the failure reason. For inactivity timeout, consider a longer `timeoutSeconds`, an async rerun, or doing the work yourself. Explain the next step briefly and concretely.

### Async completion turn

If a background handback or continuation arrives, answer the original request using the completed child result. Present the result the same way you would for sync delegation: include the artifact, synthesize analysis, and avoid launch/status chatter.

### Status line without an explicit user ask

If you only see an orchestrator status line, do not assume the user wants a status explanation. Inspect with `delegate_subagent_status` only when needed to complete the task or answer an explicit question.

## Examples

### Single reviewer, sync

```json
{
  "agent": "reviewer",
  "task": "Review the current working tree diff for correctness, regressions, security/data-loss risk, and validation gaps.",
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
  "context": "fresh",
  "async": false
}
```

### Parallel async launch

```json
{
  "tasks": [
    { "task": "Inspect the UI composition points for the feature." },
    { "task": "Inspect the data flow and state management for the feature." }
  ],
  "context": "fresh",
  "async": true
}
```

### Common status checks

```json
{ "action": "get", "runId": "<returned-run-id>" }
```

```json
{ "action": "tree" }
```

```json
{ "action": "log", "childSessionId": "<child-session-id>" }
```

```json
{ "action": "stream", "childSessionId": "<child-session-id>" }
```

```json
{ "action": "stream_next", "childSessionId": "<child-session-id>", "cursor": "<cursor-from-stream-or-stream_next>" }
```

```json
{ "action": "cancel", "runId": "<returned-run-id>" }
```

## Guidance for synthesis

After children return, merge overlapping findings, call out conflicts or uncertainty explicitly, keep exact file names and line ranges when useful, and turn child output into a clear recommendation or next step.
