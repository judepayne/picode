# agent-assets

`agent-assets` owns `picode`'s built-in agent and subagent card assets and resolves the effective runtime manifest that other extensions consume.

After the asset-resolution redesign, this extension is no longer just a directory announcer. It is responsible for:

- locating the built-in card files under:
  - `extensions/agent-assets/agents/`
  - `extensions/agent-assets/subagents/`
- loading optional user overlay config from Pi settings:
  - project: `.pi/settings.json`
  - global: `~/.pi/agent/settings.json`
- reading only the `picode` namespace from those settings files
- applying optional environment-variable overrides:
  - `PICODE_AGENT_DIR`
  - `PICODE_SUBAGENT_DIR`
  - `PICODE_AGENT_OVERRIDE_ON_CONFLICT`
  - `PICODE_SUBAGENT_OVERRIDE_ON_CONFLICT`
- merging native and user files by filename
- applying per-kind conflict policy (`prefer-user` or `prefer-native`)
- validating the resolved asset set and emitting diagnostics
- exposing resolved file manifests to downstream consumers

## Built-in asset locations

The shipped markdown cards live here:

- agents: `extensions/agent-assets/agents/`
- subagents: `extensions/agent-assets/subagents/`

These are package-owned assets. They update when `picode` updates.

## User overlay config

Users may optionally add a `picode` block to Pi settings to layer in custom cards or override shipped cards.

Locations:

- project: `.pi/settings.json`
- global: `~/.pi/agent/settings.json`

Shape:

```json
{
  "picode": {
    "agentsDir": "./custom-agents",
    "subagentsDir": "./custom-subagents",
    "agentsOnConflict": "prefer-user",
    "subagentsOnConflict": "prefer-native"
  }
}
```

Project settings override global settings, following Pi's normal settings precedence.

## Environment variables

Environment variables are supported as override-only behavior. They are not the canonical durable configuration surface.

Supported variables:

- `PICODE_AGENT_DIR`
- `PICODE_SUBAGENT_DIR`
- `PICODE_AGENT_OVERRIDE_ON_CONFLICT`
- `PICODE_SUBAGENT_OVERRIDE_ON_CONFLICT`

Conflict env vars accept either:

- `prefer-user`
- `prefer-native`

or boolean-style values:

- `true`, `1`, `yes`, `on` → `prefer-user`
- `false`, `0`, `no`, `off` → `prefer-native`

## Merge rules

Resolution happens independently for agents and subagents.

1. Start with the built-in shipped files.
2. Load the optional user overlay directory, if configured.
3. Merge by filename.

Rules:

- non-conflicting user files are added to the effective set
- same-filename conflicts use the configured conflict policy
- `prefer-user` means the user file shadows the native file
- `prefer-native` means the native file stays active and the user file is ignored for runtime resolution

## Diagnostics

`agent-assets` emits diagnostics for situations such as:

- invalid `settings.json`
- invalid `picode` values or conflict-policy values
- missing or invalid overlay directories
- ignored conflicting user files when policy is `prefer-native`
- duplicate logical identities in the resolved set

Diagnostics are meant to make configuration problems legible without requiring consumer extensions to rediscover or reinterpret asset state.

## Consumer contract

Downstream consumers do not scan directories themselves.

Instead, they consume resolved manifests from `agent-assets`, including:

- resolved agent files
- resolved subagent files
- diagnostics

Current consumers:

- `extensions/agent-mode/` reads the resolved agent file list to build the available modes
- `extensions/subagent-orchestrator/` reads the resolved agent and subagent file lists to hydrate delegated runs and max-depth metadata

That separation is the core point of this subsystem: `agent-assets` owns asset discovery and precedence; consumers own their domain logic.
