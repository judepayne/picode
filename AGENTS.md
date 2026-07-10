# AGENTS.md

This file is a fast bootstrap guide for coding agents working in `@judepayne/picode`.

## Project purpose

`picode` is a Pi package for disciplined, role-based coding workflows.

It combines:
- named top-level agent modes: **Builder**, **Planner**, **Designer**
- delegated subagents: **scout**, **worker**, **reviewer**
- permission profiles via **pi-gate**
- prompt interpolation and runtime vars via **z-prompt-vars**
- mediated subagent orchestration built on **subagent-orchestrator** + **subagent-mode**
- replayable subagent stream telemetry, TUI tap-in monitoring, and unified subagent footer navigation
- package-owned agent/subagent card assets via **agent-assets**

If you are new to the repo, the mental model is:

1. `agent-assets` resolves the shipped and user-overlaid markdown cards.
2. `agent-mode` turns resolved agent cards into the active top-level mode.
3. `pi-gate` enforces the active permission profile.
4. `z-prompt-vars` injects `${...}` prompt vars and manages `.pi` var files.
5. `subagent-orchestrator` mediates delegated work.
6. `subagent-mode` runs the delegated child processes underneath.

## Product maturity — ALPHA (2026-07-10)

`picode` is currently an **ALPHA** product. Unless a user or task explicitly requires compatibility, do not preserve obsolete behavior with migration layers, deprecated aliases, or compatibility shims. Prefer surgical removal of obsolete paths and update source, tests, and documentation together. Avoid broad unrelated rewrites: alpha status removes the default backward-compatibility requirement, not the requirement to keep changes focused and verified.

## Fast bootstrap reading order

If you only have a few minutes, read in this order:

1. `README.md` — package-level workflow and user-facing behavior.
2. `package.json` — package entrypoints, shipped resources, peer dependencies.
3. `extensions/agent-assets/README.md` — how built-in and user-overlay agent/subagent cards are resolved.
4. `extensions/agent-mode/README.md` — how top-level modes are applied.
5. `extensions/subagent-orchestrator/README.md` — how delegated subagents are launched and surfaced.
6. `extensions/z-prompt-vars/README.md` — prompt vars, plan/design paths, and `.pi` bootstrap behavior.
7. `extensions/pi-gate/README.md` — permission model and runtime profile switching.

Then read the specific extension code you are changing.

## Main folder index

| Path | What it contains | Start here when... |
| --- | --- | --- |
| `extensions/` | The actual Pi extension implementations shipped by this package. | You are changing runtime behavior. |
| `extensions/agent-assets/` | Built-in agent/subagent card assets plus resolver logic for user overlays. | You need to add or change built-in modes/subagents or asset resolution. |
| `extensions/agent-mode/` | Top-level mode switching and mode prompt/runtime application. | You are changing Builder/Planner/Designer selection or mode wiring. |
| `extensions/pi-gate/` | Permission policy engine and profile switching. | You are changing policy behavior or profile rules. |
| `extensions/subagent-mode/` | Low-level child-runner substrate for delegated subagents. | You are changing process spawning, sync/async child execution, or normalized child events. |
| `extensions/subagent-orchestrator/` | User-facing and agent-facing delegation layer, stream API, tap-in UI, and unified footer tree. | You are changing `~subagent`, `delegate_subagent`, run tracking, handbacks, streams/logs, tap navigation/transcripts, or run UI/footer status. |
| `extensions/z-prompt-vars/` | Prompt interpolation, runtime vars, plan/design derived vars, bootstrap of `.pi` files. | You are changing `${...}` prompt vars or `/vars` behavior. |
| `skills/` | Reusable agent instructions for planning, delegation, prompt vars, and coding discipline. | You are changing agent guidance rather than runtime code. |
| `examples/` | Worked examples of custom subagent workflows built on picode. | You want a realistic composition example. |
| `img/` | README/package images. | You are updating docs visuals. |
| `.pi/` | Project-local runtime state during development. Typically gitignored, may not exist. | You are inspecting local vars, plans/designs, or orchestrator state. |

## Key top-level files

| File | Purpose |
| --- | --- |
| `README.md` | Canonical package overview and usage docs. |
| `package.json` | Package metadata, shipped files, Pi resource registration, export surface. |
| `CHANGELOG.md` | Release history. |
| `.gitignore` | Local ignore rules; this file now ignores `AGENTS.md`. |
| `checklist.md` | Misc project-local notes/checklist file. |

## Extension map

### `extensions/agent-assets/`

Owns the built-in markdown cards and resolves the effective runtime manifest consumed by other extensions.

Important files:
- `extensions/agent-assets/index.ts` — extension entrypoint
- `extensions/agent-assets/resolver.ts` — resolution/merge logic
- `extensions/agent-assets/config.ts` — settings/env parsing
- `extensions/agent-assets/contract.ts` — exported contract
- `extensions/agent-assets/agents/` — built-in top-level mode cards
- `extensions/agent-assets/subagents/` — built-in delegated subagent cards

Read this first if the change affects:
- Builder / Planner / Designer definitions
- scout / worker / reviewer definitions
- user overlays from `.pi/settings.json`
- partial same-filename overlay merging between native and user cards

### `extensions/agent-mode/`

Turns resolved agent cards into the active main-agent mode. Applies tools, model, thinking level, gate profile, allowed subagents, and the mode prompt each turn.

Important files:
- `extensions/agent-mode/index.ts` — extension integration
- `extensions/agent-mode/runtime.ts` — runtime mode state/application
- `extensions/agent-mode/settings.json` — default keybindings/settings

Read this first if the change affects:
- `/agents`
- mode switching
- footer mode state
- mode-specific runtime constraints

### `extensions/pi-gate/`

Permission layer with OpenCode-style policies, profile inheritance, and runtime profile switching.

Important files:
- `extensions/pi-gate/index.ts` — public extension entrypoint/re-exports
- `extensions/pi-gate/runtime.ts` — thin runtime composition and lifecycle wiring
- `extensions/pi-gate/policy-loader.ts`, `policy-compiler.ts`, `policy-evaluator.ts` — deterministic policy core
- `extensions/pi-gate/profile-controller.ts` — profile selection, lineage, and queued switching
- `extensions/pi-gate/enforcement/tool-handler.ts` — policy/auto tool enforcement ordering
- `extensions/pi-gate/semantic/decision-flow.ts` — semantic approval, risk floors, and prompt fallback
- `extensions/pi-gate/commands.ts` — `/gate` command routing
- `extensions/pi-gate/policy.json`
- `extensions/pi-gate/policy.schema.json`

Read this first if the change affects:
- builder/planner/designer permission behavior
- ask/allow/deny resolution
- runtime gate profile switching

### `extensions/subagent-mode/`

Low-level execution substrate for delegated child runs. Most user-facing delegation features are built on top of this.

Important files:
- `extensions/subagent-mode/index.ts`
- `extensions/subagent-mode/types.ts`
- `extensions/subagent-mode/runner.ts`
- `extensions/subagent-mode/sync-executor.ts`
- `extensions/subagent-mode/async-executor.ts`
- `extensions/subagent-mode/orchestrator-bridge.ts`
- `extensions/subagent-mode/pi-spawn.ts`
- `extensions/subagent-mode/normalizer.ts`

Read this first if the change affects:
- child process spawning
- normalized JSON event streams
- sync vs async delegated execution
- delegation depth propagation

### `extensions/subagent-orchestrator/`

Public delegation layer for both the top-level agent and direct user `~subagent` commands. It also owns subagent stream replay/follow, the TUI tap-in transcript, and the unified footer tree used for both normal subagent status and tap navigation.

Important files:
- `extensions/subagent-orchestrator/index.ts` — runtime composition and event/controller wiring
- `extensions/subagent-orchestrator/run-launcher.ts` — transactional delegated-run launch
- `extensions/subagent-orchestrator/async-recovery.ts` — async event/artifact recovery
- `extensions/subagent-orchestrator/run-state-service.ts` — independent child/run terminal transition claims
- `extensions/subagent-orchestrator/card-config-resolver.ts` — registration-local asset snapshot and card caches
- `extensions/subagent-orchestrator/continuation-controller.ts` — user and agent continuation state/validation
- `extensions/subagent-orchestrator/register-tools.ts` — delegate/status/dev tool registration
- `extensions/subagent-orchestrator/lifecycle.ts` — guarded Pi lifecycle registration and disposal
- `extensions/subagent-orchestrator/user-dispatch.ts` — `~scout` / `~worker` / `~reviewer`
- `extensions/subagent-orchestrator/delegate-input.ts` — tool input normalization
- `extensions/subagent-orchestrator/state.ts` — persistent run/child/handback state plus node-log JSONL cursors
- `extensions/subagent-orchestrator/stream.ts` — replay/live stream API over child node logs
- `extensions/subagent-orchestrator/stream-handlers.ts` — reusable sanitized stream event sinks such as JSONL file logging
- `extensions/subagent-orchestrator/tap-controller.ts` — TUI tap-in lifecycle, keyboard navigation, selected-child stream subscription
- `extensions/subagent-orchestrator/tap-navigation.ts` — tap tree construction, selection movement, footer tree formatting/status colors
- `extensions/subagent-orchestrator/tap-transcript-tree.ts` — above-editor transcript renderer using persistent cached nodes from sanitized stream events
- `extensions/subagent-orchestrator/handbacks.ts` — completion/handback behavior
- `extensions/subagent-orchestrator/footer-status.ts` — notification text helpers, not the unified footer tree renderer
- `extensions/subagent-orchestrator/run-ui.ts` — surfaced UI/run card behavior
- `extensions/subagent-orchestrator/sticky-user-sessions.ts` — continue semantics for direct user subagents
- `extensions/subagent-orchestrator/max-subagent-depth.ts` — nested delegation bounds

Read this first if the change affects:
- `delegate_subagent`
- `delegate_subagent_status`
- async run tracking or cancellation
- handbacks, trees, logs, node-log cursors, streams, or `dev_subagent_stream_to_file`
- TUI tap-in navigation/transcripts (`Ctrl+/`, `Esc`, `Ctrl+,`, `Ctrl+.`, `Ctrl+O`)
- unified subagent footer tree display, lifecycle colors, selected marker, or terminal-run retention
- `~subagent` shorthand behavior

Current footer/tap model:
- Normal footer and active tap footer share the status key `subagent-orchestrator` intentionally.
- The transcript widget key is separate: `subagent-orchestrator-tap`.
- Root/run levels are footer-only; the above-editor transcript is shown only when a child node is selected.
- Footer grammar: `>` for nesting, `→` for chain steps, `,` for parallel siblings. Selection uses `●`; lifecycle color carries status.
- Lifecycle colors are centralized in `createTapFooterFormatters(...)` / `styleNodeLabel(...)` in `tap-navigation.ts`.
- Terminal runs should remain visible until the next submitted interactive user turn.
- Stream identity is `childSessionId`; node logs are the replay source of truth.

### `extensions/z-prompt-vars/`

Interpolates prompt vars and manages the project/global vars files used by prompt text and runtime state.

Important files:
- `extensions/z-prompt-vars/index.ts` — hooks, `/vars`, vars tool registration
- `extensions/z-prompt-vars/prompt-vars.ts` — core var loading, merging, bootstrap, mutation, derived plan/design vars

Key runtime files it manages:
- `.pi/agent-mode-vars.json`
- `.pi/agent-mode-vars-config.json`
- default plan path: `.pi/plans/active.md`
- default design path: `.pi/designs/active.md`

Write-location rule:
- `.pi/agent-mode-vars-config.json` stores `pi-location`, which controls whether ordinary vars mutations write to the project or global vars file.
- `/gate auto setup` uses the ordinary vars write path and already respects the selected `pi-location`; do not add a separate scope override without an explicit product decision.
- `automode.enabled` and `gate.auto.enabled` are intentional exceptions forced to project-local state regardless of `pi-location`.

Read this first if the change affects:
- `${plan.path}` / `${design.path}`
- `/vars` or vars tool behavior
- bootstrap of project-local `.pi` config
- read precedence between project/global vars

## Skills map

These are guidance artifacts for agents, not runtime extensions.

| Skill | File | Purpose |
| --- | --- | --- |
| Karpathy coding discipline | `skills/karpathy-coding-discipline/SKILL.md` | Behavioral guardrails for implementation work: think first, keep changes simple, stay surgical, verify outcomes. |
| Orchestrate subagents | `skills/orchestrate-subagents/SKILL.md` | How to choose `task` vs `tasks` vs `chain`, sync vs async, and `fresh` vs `fork` vs explicit `continue`. |
| Planning workflow | `skills/planning-workflow/SKILL.md` | Structured repo-grounded planning workflow for producing Builder-ready plans. |
| Prompt vars | `skills/prompt-vars/SKILL.md` | How to use `${...}` vars, `.pi` var files, and the vars tool/command correctly. |

## Shipped built-in agents and subagents

Built-in cards live in `extensions/agent-assets/`.

Top-level agents:
- `extensions/agent-assets/agents/01-builder.md`
- `extensions/agent-assets/agents/02-planner.md`
- `extensions/agent-assets/agents/03-designer.md`

Delegated subagents:
- `extensions/agent-assets/subagents/scout.md`
- `extensions/agent-assets/subagents/worker.md`
- `extensions/agent-assets/subagents/reviewer.md`

If a behavior change looks like “the agent should act differently” rather than “the extension should behave differently”, check these markdown cards before changing TypeScript.

## Examples

| Path | Purpose |
| --- | --- |
| `examples/team-lead.md` | Example custom subagent card for staged PR workflow management. |
| `examples/pr-management/README.md` | Explains the staged nested-subagent PR workflow. |
| `examples/pr-management/SKILL.md` | Teaches a parent agent how to run that staged workflow with explicit continuation. |

Use these when you need a concrete example of nested orchestration beyond the shipped scout/worker/reviewer set.

## Tests

Most extensions keep focused tests under their own `test/` directories, for example:
- `extensions/agent-assets/test/`
- `extensions/agent-mode/test/`
- `extensions/pi-gate/test/`
- `extensions/subagent-mode/test/`
- `extensions/subagent-orchestrator/test/`
- `extensions/z-prompt-vars/test/`

Run the full TypeScript extension suite with `npm test` from the repo root. This script runs `node --test "extensions/**/*.test.ts"`.

When changing one extension, validate with that extension's tests first.

## Practical bootstrap tips for future agents

- Prefer `README.md` plus the relevant extension `README.md` over broad repo scanning.
- If you need to understand shipped personas, read the markdown cards under `extensions/agent-assets/agents/` and `extensions/agent-assets/subagents/`.
- If you need prompt-var behavior, read `extensions/z-prompt-vars/prompt-vars.ts`; that is the core implementation.
- If you need orchestration behavior, read `extensions/subagent-orchestrator/index.ts` plus `user-dispatch.ts`, `state.ts`, and `handbacks.ts`.
- If you need low-level child execution behavior, read `extensions/subagent-mode/types.ts`, `runner.ts`, and the executor files.
- Do not assume `.pi/` exists in a fresh checkout.
- For vars bootstrap, prefer the runtime bootstrap path or `/vars bootstrap`; do not manually invent `.pi` file contents unless explicitly needed.

## Common task → where to look

| Task | First files to inspect |
| --- | --- |
| Add or edit a built-in mode | `extensions/agent-assets/agents/*.md`, then `extensions/agent-mode/README.md` |
| Add or edit a built-in subagent | `extensions/agent-assets/subagents/*.md`, then `extensions/subagent-orchestrator/README.md` |
| Change overlay resolution | `extensions/agent-assets/resolver.ts`, `extensions/agent-assets/config.ts` |
| Change mode switching | `extensions/agent-mode/index.ts`, `extensions/agent-mode/runtime.ts` |
| Change gate policy/profile behavior | `extensions/pi-gate/index.ts`, `extensions/pi-gate/policy.json` |
| Change `~subagent` behavior | `extensions/subagent-orchestrator/user-dispatch.ts` |
| Change delegation tool behavior | `extensions/subagent-orchestrator/index.ts`, `delegate-input.ts`, `state.ts` |
| Change subagent stream/log replay behavior | `extensions/subagent-orchestrator/stream.ts`, `state.ts`, `stream-handlers.ts` |
| Change tap-in keyboard navigation or transcript rendering | `extensions/subagent-orchestrator/tap-controller.ts`, `tap-navigation.ts`, `tap-transcript-tree.ts` |
| Change unified subagent footer display/colors/navigation tree | `extensions/subagent-orchestrator/tap-navigation.ts`, `tap-controller.ts`, `index.ts` |
| Change async child execution | `extensions/subagent-mode/async-executor.ts`, `runner.ts`, `pi-spawn.ts` |
| Change prompt vars or `/vars` | `extensions/z-prompt-vars/index.ts`, `prompt-vars.ts` |
| Change planning/delegation guidance | `skills/*.md` |

## Notes on local runtime state

This repo often creates local `.pi/` files during use. Common examples:
- `.pi/agent-mode-vars.json`
- `.pi/agent-mode-vars-config.json`
- `.pi/plans/active.md`
- `.pi/designs/active.md`
- `.pi/state/subagent-orchestrator/...`
- `.pi/state/subagent-orchestrator/node-logs/*.jsonl`

These are runtime artifacts, not core source files. The orchestrator node logs are useful for debugging stream replay/tap behavior, but they are local state and should not be treated as source.

## Bootstrap rule

When a user asks for a bootstrap or repository bootstrap, keep it minimal.

- Read `AGENTS.md` first.
- Do not investigate further by default.
- Do not proactively read other files unless the user explicitly asks, or the bootstrap request itself explicitly asks for deeper reconnaissance.
