# Bug: automode handoff can leave agent-mode prompt and pi-gate profile out of sync

## Summary

During the Design → Plan → Build automode flow, the visible/system handoff reached Builder, but the runtime pi-gate profile remained `designer`. As a result, source edits were denied even though the handoff prompt said Builder should implement the plan.

Observed in this session:

```text
$ git status --short && echo GATE_PROFILE=$GATE_PROFILE
GATE_PROFILE=designer
```

Attempting to edit source under the supposed Builder handoff failed with a Designer gate denial:

```text
[designer] edit deny: .../extensions/pi-gate/auto-approver/types.ts (matched "*")
```

Repeated calls to `switch_agent_mode({ mode: "Builder", triggerTurn: true, ... })` reported success and queued follow-up turns, but the next turns initially still had `GATE_PROFILE=designer`. The user later observed that the mode/profile eventually flipped after a long delay, so this is not just a permanently lost handoff; there is also a delayed-application/race/asynchrony path.

## Impact

Automode can enter a split-brain state:

- conversation/handoff text says the next turn is Builder;
- agent instructions may tell the model to implement;
- pi-gate still enforces Designer permissions;
- implementation stalls because source edits are denied.

This is particularly confusing because the handoff tool returns a successful message (`Queued agent mode switch to Builder...`) even when the effective gate profile in the follow-up turn does not change.

## Relevant code

`extensions/agent-mode/index.ts` keeps queued mode switches only in an in-memory variable:

```ts
function queueModeSwitchForTool(ctx, identifier) {
  ...
  pendingModeIndex = nextIndex;
  return { mode: modes[nextIndex] };
}

async function applyPendingModeSwitch(ctx) {
  if (pendingModeIndex === undefined) return undefined;
  if (readAutomodeEnabled(ctx, getCurrentMode()?.id) !== "true") {
    pendingModeIndex = undefined;
    return undefined;
  }
  currentIndex = pendingModeIndex;
  pendingModeIndex = undefined;
  await applyCurrentMode(ctx, { persist: true });
  return getCurrentMode();
}
```

`before_agent_start` is the only place that applies the queued mode:

```ts
pi.on("before_agent_start", async (event, ctx) => {
  const pendingMode = await applyPendingModeSwitch(ctx);
  if (!pendingMode) {
    await applyCurrentMode(ctx, { persist: false, notify: false });
  }
  ...
});
```

`applyCurrentMode` is where `process.env.GATE_PROFILE` gets updated and the pi-gate profile switch event is emitted:

```ts
if (process.env.GATE_PROFILE_LOCK !== "1" && process.env.GATE_PROFILE_LOCK?.toLowerCase() !== "true") {
  process.env.GATE_PROFILE = current.profile;
}
pi.events.emit("gate:switch-profile", { profile: current.profile, notify: false, source: "agent-mode" });
```

## Likely cause

The handoff target is not persisted as durable state and mode/profile application appears to race queued follow-up turn delivery. `switch_agent_mode` stores the target in `pendingModeIndex` in memory, then queues a hidden follow-up message. If the extension instance/process/session state changes before `before_agent_start` runs, or if the follow-up is replayed after compaction/restart, the queued in-memory `pendingModeIndex` is gone. If the follow-up turn starts before the profile-switch side effects have completed, the prompt/runtime may also observe the old gate profile until a later lifecycle event finally applies the target.

The hidden handoff message does include target details:

```ts
pi.sendMessage({
  customType: MODE_HANDOFF_MESSAGE_TYPE,
  details: {
    targetMode: targetMode.name,
    targetModeId: targetMode.id,
  },
  ...
});
```

But `before_agent_start` does not appear to read the handoff message details from session history to recover/apply the target mode. So the follow-up text can survive while the actual pending switch does not.

A secondary possibility is that `applyPendingModeSwitch` clears the pending switch if `readAutomodeEnabled(ctx, getCurrentMode()?.id) !== "true"`. If automode state is mode-scoped in a way that does not match the current mode id during handoff, the queued switch can be dropped. In this session `automode.enabled` was still globally reported as `true`, so the more likely problem is non-durable pending handoff state.

## Why existing tests may not catch it

`extensions/agent-mode/test/index.test.ts` has a test for `switch_agent_mode queues mode changes until the next agent turn`, but it exercises the queue and next `before_agent_start` in the same extension instance. That validates the in-memory path but not replay/restart/compaction durability.

The failing real-world path appears to involve either a hidden handoff turn that survives independently of the in-memory `pendingModeIndex`, or a queued lifecycle event/profile switch that applies only after one or more turns have already begun.

## Suggested fix

Make automode handoffs durable and self-healing.

Options:

1. Persist the pending target mode when `switch_agent_mode` is called, e.g. in a custom session entry or z-prompt-vars (`automode.pendingModeId`). `before_agent_start` should apply and clear that durable pending mode.
2. Alternatively, teach `before_agent_start` to detect the latest `agent-mode-handoff` custom message and apply its `details.targetModeId` before constructing the mode prompt.
3. Prefer doing both defensively: persist a pending mode id and also reconcile from the handoff message if the in-memory pending value is absent.

Required behavior:

- If a handoff turn says target Builder, `before_agent_start` must set current mode to Builder before tool constraints and gate profile are applied.
- The gate profile must be verified/updated synchronously before the follow-up turn can execute tools under the old profile.
- The queued target should be cleared only after successful `applyCurrentMode`.
- If the target mode is missing/invalid, the user should get a clear warning instead of silent fallback to the old mode.

## Suggested regression tests

Add tests in `extensions/agent-mode/test/index.test.ts`:

1. Simulate `switch_agent_mode(... triggerTurn: true)`, then create a fresh extension instance/session context containing the handoff custom message but no in-memory `pendingModeIndex`. Assert `before_agent_start` applies the target mode and `GATE_PROFILE=builder`.
2. Simulate a delayed profile-switch/event flush around a queued handoff and assert the first follow-up turn already has the target profile before any tool gating can run.
3. Simulate automode Design → Plan → Build across fresh extension instances. Assert each handoff applies the expected profile.
4. Assert invalid/missing durable handoff target does not silently report success while leaving the previous gate profile active.

## Workaround

Manual `/agents Builder` should force the current mode/profile if the UI command path is functioning. In this session, repeated agent-driven `switch_agent_mode` calls were insufficient because they queued another non-durable handoff while the active gate profile remained Designer.
