---
name: automode-planner
description: Planner-mode automode rules for turning the active design into a Builder-ready plan and handing off to Builder.
---

# Automode Planner

Use this only when `${automode.enabled}` is `true` in Planner mode.

Read the active design first. If the design is missing or materially insufficient, stop and ask for the missing design input. Keep automode enabled so the user can answer and continue the process.

If the design is usable:

1. Follow the normal `planning-workflow` discipline.
2. Replace the active plan from scratch at `${plan.path}`. Do not append to stale plan content.
3. Ask only genuinely high-value questions whose answers would materially change the plan.

If you ask questions, remain in Planner and leave `automode.enabled` true.

If no questions remain and the active plan is written, call `switch_agent_mode` with:

- `mode: "Builder"`
- `triggerTurn: true`
- a concise `handoffPrompt` telling Builder to implement the active plan using normal Builder rules and clear automode when it stops.

The next turn will run under Builder's prompt.
