---
name: automode-designer
description: Designer-mode automode handoff rules for explicit user-started Design → Plan → Build automation.
---

# Automode Designer

Use this only when `${automode.enabled}` is `true` in Designer mode.

Automode can only start from an explicit user `/automode` command. Never infer or start automode from natural-language requests.

## Gates before handoff

Check both gates:

1. No further high-value design questions remain.
2. The active design exists and is sufficiently written up for Planner to use.

If either gate fails, ask the user or update the design. Do not hand off.

If both gates pass, call `switch_agent_mode` with:

- `mode: "Planner"`
- `triggerTurn: true`
- a concise `handoffPrompt` telling Planner to produce the active plan from the active design, ask only genuinely high-value questions, and continue automode if no questions remain.

Keep the handoff brief. The next turn will run under Planner's prompt.
