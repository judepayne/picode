# agent-assets

`agent-assets` owns `picode`'s built-in agent and subagent card assets and resolves the effective runtime card maps that other extensions consume.

It is responsible for:

- locating the built-in card files under:
  - `extensions/agent-assets/agents/`
  - `extensions/agent-assets/subagents/`
- loading optional user overlay config from Pi settings:
  - project: `.pi/settings.json`
  - global: `~/.pi/agent/settings.json`
- reading only the `picode` namespace from those settings files
- applying optional environment-variable directory overrides:
  - `PICODE_AGENT_DIR`
  - `PICODE_SUBAGENT_DIR`
- parsing flat markdown frontmatter and prompt bodies into card maps
- merging same-filename native/user cards by shallow map merge
- adding different-filename user cards to the effective set
- resolving file-relative `extensions` values for markdown cards it loads
- validating the resolved card set and emitting diagnostics
- exposing ordered effective card maps to downstream consumers

## Built-in asset locations

The shipped markdown cards live here:

- agents: `extensions/agent-assets/agents/`
- subagents: `extensions/agent-assets/subagents/`

These are package-owned assets. They update when `picode` updates.

## User overlay config

Users may optionally add a `picode` block to Pi settings to layer in custom cards or partially override shipped cards.

Locations:

- project: `.pi/settings.json`
- global: `~/.pi/agent/settings.json`

Shape:

```json
{
  "picode": {
    "agentsDir": "./custom-agents",
    "subagentsDir": "./custom-subagents"
  }
}
```

Project settings override global settings, following Pi's normal settings precedence.

## Environment variables

Environment variables are supported as override-only behavior. They are not the canonical durable configuration surface.

Supported variables:

- `PICODE_AGENT_DIR`
- `PICODE_SUBAGENT_DIR`

## Merge rules

Resolution happens independently for agents and subagents.

1. Start with the built-in shipped cards.
2. Load the optional user overlay directory, if configured.
3. Merge cards by filename.

Rules:

- a user file with a different filename is added as a new card
- a user file with the same filename as a built-in card partially overrides that built-in card
- merge is shallow: user frontmatter keys replace built-in keys one-for-one
- blank user frontmatter values are ignored, so the built-in value is inherited
- a non-empty user prompt body replaces the built-in prompt body entirely
- an empty or whitespace-only user prompt body is ignored, so the built-in prompt is inherited
- list-like fields such as `tools`, `banned_subagents`, `ban_tools`, and `extensions` replace wholesale as strings; they are not appended or diffed
- `name` is required on every final card; same-filename overrides may inherit the built-in `name`, but new user-only cards without `name` are skipped with a diagnostic
- final names must be unique after slug normalization, so `Research Assistant` and `research-assistant` conflict

For example, a user overlay file at `~/.pi/picode-agents/01-builder.md` can contain only:

```md
---
banned_subagents: expensive-specialist
---
```

That keeps the built-in Builder prompt and all other settings, but adds a non-inherited direct delegation ban.

## Diagnostics

`agent-assets` emits diagnostics for situations such as:

- invalid `settings.json`
- invalid `picode` path values
- missing or invalid overlay directories
- user-only cards without a final `name`
- duplicate final card names
- unreadable card files

Diagnostics are meant to make configuration problems legible without requiring consumer extensions to rediscover or reinterpret asset state.

## Consumer contract

Downstream consumers do not scan directories or parse markdown themselves.

Instead, they collect one `AgentAssetSnapshot` per logical load from `agent-assets`. The snapshot contains:

- ordered source entries
- resolved agent cards
- resolved subagent cards
- diagnostics from the same collection event

Consumers use `collectAgentAssetSnapshot(...)` so cards and diagnostics always come from the same event-bus resolution.

Current consumers:

- `extensions/agent-mode/` reads the resolved agent cards to build the available modes
- `extensions/subagent-orchestrator/` reads the resolved agent and subagent cards to hydrate delegated runs and max-depth metadata

That separation is the core point of this subsystem: `agent-assets` owns asset discovery and card materialization; consumers own their runtime interpretation of card fields.

If another extension contributes card maps directly through the collection event, it should provide already-materialized values. In particular, `extensions` paths should already be absolute or otherwise meaningful to the child process, because direct card maps do not carry file-source metadata.
