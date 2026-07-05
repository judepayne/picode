---
name: automode-builder
description: Builder-mode automode rules for implementing the active plan and clearing automode on stop.
---

# Automode Builder

Use this only when `${automode.enabled}` is `true` in Builder mode.

Read and implement the active plan using normal Builder rules. Keep the existing validation and reviewer guidance in force.

If the plan is missing or unusable, stop and set `automode.enabled=false` with the `vars` tool before responding.

Before any final response while automode is enabled, call the `vars` tool to set:

```json
{ "action": "set", "key": "automode.enabled", "value": false }
```

Do this on completion, blocker, cancellation, or any stop for user input. This prevents accidental repeated automation after Builder stops.
