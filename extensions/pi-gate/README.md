# pi-gate

Permission gate for pi with an OpenCode-compatible policy format, profile inheritance, and path-aware bash checks.

## Files

- `index.ts` — public extension entrypoint and named re-exports
- `runtime.ts` — runtime composition and lifecycle registration
- `policy-loader.ts`, `policy-compiler.ts`, `policy-evaluator.ts` — deterministic policy loading, compilation, and evaluation
- `profile-controller.ts` — profile selection, lineage, and queued switching
- `shell-mutation.ts`, `policy-shell.ts`, `tool-classification.ts` — conservative shell and tool classification
- `enforcement/tool-handler.ts` — policy/auto enforcement routing and security ordering
- `semantic/decision-flow.ts` — semantic approval, risk floors, and prompt fallback
- `commands.ts` and `auto-approver/setup.ts` — command and setup behavior
- `status-ui.ts` — footer and Gate Auto status formatting
- `policy.json` — deterministic policy-mode rules
- `policy.schema.json` — JSON Schema for `policy.json`
- `auto.json` — semantic auto-approval guidance, hard denies, and always-allow shortcuts
- `auto.schema.json` — JSON Schema for `auto.json`
- `LICENSE` — MIT license

## Install

Put this directory at:

```text
~/.pi/agent/extensions/pi-gate/
```

pi auto-discovers extensions from that location.

## Use

Start pi, or if pi is already running, reload:

```text
/reload
```

## What it does

pi-gate has two related pieces:

1. **Policy mode** — the normal deterministic gate. It reads `policy.json` and decides whether each tool call should be allowed, denied, or sent to you for approval.
2. **Auto mode** — an optional semantic local-model gate. It uses `auto.json` for deterministic `hardDeny` rules, narrow role-specific `alwaysAllow` rules, and per-agent/subagent guidance for the local model.

In policy mode, pi-gate:

- uses an OpenCode-style `permission` block
- supports profiles with `inherits-from`
- shows the active profile in the footer as `gate:<profile>`
- supports:
  - Allow once
  - Allow for session
- can switch profiles at runtime and clears cached approvals when the profile changes
- accepts inter-extension profile switch requests and, if a turn is active, queues the switch until `agent_end`
- applies delegated subagent profile lineage ceilings from `PI_GATE_PROFILE_LINEAGE` by evaluating each concrete tool call against every profile in the lineage and choosing the strictest result (`deny > ask > allow`)
- fails closed if policy loading or validation fails; tool calls are blocked until the policy is fixed

In auto mode, pi-gate:

- uses `auto.json`, not `policy.json` ask/allow tables, for the semantic path
- enforces policy/lineage denies, evaluates `hardDeny`, then optional role/global `alwaysAllow`, then asks the local model
- has separate guidance and optional `alwaysAllow` shortcuts for agents and subagents
- never turns one approval into an `Allow for session`
- runs against a local llama.cpp-compatible endpoint or a managed local `llama-server`
- shows `gate:<profile> auto` in the footer
- logs model decisions to `.pi/state/pi-gate/auto-decisions.jsonl`

## Commands

- `/gate` — show status
- `/gate status` — show status
- `/gate switch` — picker for available profiles
- `/gate clear` — clear cached session approvals
- `/gate auto setup` — run the bundled setup helper and save discovered local model/server paths
- `/gate auto status` — show local auto-approver status
- `/gate auto on` — explicitly enable semantic local auto-approval
- `/gate auto off` — disable auto-approval and stop the managed runtime

## Policy mode

Policy mode is the core of pi-gate. It is always active.

`policy.json` is intentionally close to OpenCode.

Top-level keys:

- `$schema`
- `activeProfile`
- `permission`
- `profiles`

`activeProfile` is the profile pi-gate uses on startup and after `/reload`, unless it is overridden by `GATE_PROFILE` or explicitly switched at runtime. Delegated subagent children also receive internal `PI_GATE_PROFILE_LINEAGE` metadata so nested children keep the capability ceiling of their parent delegation chain.

Runtime switching means you actively change the profile while pi is running, for example with:

```text
/gate switch
```

You can also inspect the current state with:

```text
/gate status
```

Example:

```json
{
  "$schema": "./policy.schema.json",
  "activeProfile": "builder",
  "permission": {
    "*": "allow",
    "read": {
      "*": "allow",
      "*.env": "deny"
    },
    "edit": {
      "*": "ask"
    }
  },
  "profiles": {
    "docs-writer": {
      "inherits-from": "$base",
      "permission": {
        "edit": {
          "*": "deny",
          "**/*.md": "allow"
        }
      }
    }
  }
}
```

More complete example with a base policy plus two profiles:

```json
{
  "$schema": "./policy.schema.json",
  "activeProfile": "builder",
  "permission": {
    "*": "allow",
    "external_directory": {
      "*": "ask",
      "/tmp/**": "allow",
      "~/.pi/**": "allow"
    },
    "read": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "edit": {
      "*": "allow",
      "**/.git/**": "deny",
      "/etc/**": "deny"
    },
    "bash": {
      "*": "allow",
      "git push*": "ask",
      "sudo*": "ask"
    }
  },
  "profiles": {
    "planner": {
      "inherits-from": "$base",
      "permission": {
        "edit": {
          "*": "deny",
          ".pi/plans/**": "allow"
        },
        "bash": {
          "*": "ask",
          "ls*": "allow",
          "cat*": "allow",
          "grep*": "allow",
          "git status*": "allow"
        }
      }
    },
    "docs-writer": {
      "inherits-from": "$base",
      "permission": {
        "edit": {
          "*": "deny",
          "**/*.md": "allow",
          "**/*.mdx": "allow"
        }
      }
    }
  }
}
```

## Auto mode

Auto mode is optional. Normally, policy mode resolves each tool call deterministically and asks you for unresolved `ask` cases. Auto mode replaces that prompt path with a semantic gate for the current session. Deterministic policy/lineage denies and `hardDeny` rules run first, narrow `alwaysAllow` rules can skip boring model calls, and the configured approver backend classifies the grey middle. Backends can be a managed local llama.cpp server or a model from Pi's configured model registry.

The important rules are simple:

- policy/lineage `deny` ceilings always block before auto approval
- `hardDeny` always blocks
- `alwaysAllow` is optional and only allows after the built-in risk guard agrees the call is low risk
- everything else goes to the semantic approver with trusted sequential context, except catastrophic sensitive-data/broad-destructive safety floors
- a model approval is for one concrete tool call only
- no model decision creates `Allow for session`
- unresolved calls prompt in interactive top-level sessions and block in unattended sessions
- after repeated model blocks, pi-gate pauses auto mode and asks you

When auto mode is active, the footer shows `gate:<profile> auto`.

### Quick setup

Use the interactive setup command:

```text
/gate auto setup
```

It asks which approver backend to use:

- **Local managed llama.cpp**: finds `llama-server`, downloads/verifies the default MiniCPM5-1B Q4 GGUF model if needed, and saves a `managed-llama` backend config.
- **Pi configured model**: lets you choose a model declared in `~/.pi/agent/models.json` and saves a `pi-model` backend config. This may send full Gate auto semantic context to that provider.

Setup writes the canonical `gate.auto.backend` prompt var globally. It does not enable auto mode; run `/gate auto on` after setup.

You can also run the local llama.cpp helper from a terminal:

```sh
node scripts/setup-gate-auto-approver.mjs
```

The terminal helper prints `/vars` commands for a canonical `managed-llama` backend plus `/gate auto on`.

By default, the helper stores model files under:

1. `$PICODE_GATE_AUTO_HOME`, if set
2. `$HF_HOME/picode/gate-auto-approver`, if `HF_HOME` is set
3. `~/.pi/picode/gate-auto-approver` otherwise

You can override that with `--install-dir`.

If you already manage a local llama.cpp server yourself, set the backend directly:

```text
/vars set gate.auto.backend {"type":"managed-llama","serverPath":"/path/to/llama-server","modelPath":"/path/to/MiniCPM5-1B-Q4_K_M.gguf","host":"127.0.0.1","port":0,"parallel":2,"cachePrompt":true,"startupTimeoutMs":30000,"responseFormat":"auto","enableThinking":false,"warmup":true}
/vars set gate.auto.timeoutMs 4000
/gate auto on
```

### Using it

Use these commands in Pi:

```text
/gate auto on      # start semantic auto-approval for this session
/gate auto off     # stop it
/gate auto status  # inspect status, config, and paths
```

`/gate auto on` is intentionally required. Generic `/vars set gate.auto.enabled true` is rejected so auto-approval cannot be switched on accidentally.

Auto-approval does not start automatically after a fresh Pi restart. If you want this project to start it on each Pi launch, opt in explicitly:

```text
/vars set gate.auto.startOnSession true
```

### What if setup is wrong?

pi-gate fails safe.

If the model path, server path, or local endpoint is missing or broken:

- `/gate auto on` reports that auto is not ready
- interactive top-level sessions fall back to the normal permission prompt
- unattended subagents block instead of prompting
- no missing-model or timeout case silently allows a tool call

### Backend config

Canonical backend config lives in `gate.auto.backend`.

Managed local llama.cpp:

```json
{"type":"managed-llama","serverPath":"/path/to/llama-server","modelPath":"/path/to/model.gguf","host":"127.0.0.1","port":0,"parallel":2,"cachePrompt":true,"startupTimeoutMs":30000,"responseFormat":"auto","enableThinking":false,"warmup":true}
```

External local llama.cpp endpoint:

```json
{"type":"managed-llama","endpoint":"http://127.0.0.1:8080","host":"127.0.0.1","port":0,"parallel":2,"cachePrompt":true,"startupTimeoutMs":30000,"responseFormat":"auto","enableThinking":false,"warmup":true}
```

Only local loopback HTTP endpoints are accepted for `managed-llama`.

Pi model backend:

```json
{"type":"pi-model","provider":"openai","model":"gpt-4.1-mini","thinking":"off","cacheRetention":"short","temperature":0,"maxTokens":128}
```

`pi-model` uses Pi's model registry/auth from `~/.pi/agent/models.json`. Each approval call is a fresh one-shot context. Prompt caching for public providers is best-effort/provider-dependent. Gate Auto accepts only the canonical `gate.auto.backend` object; legacy configuration shapes are not supported.

### Testing

After setup, you can run:

```sh
node scripts/eval-gate-auto-approver.mjs --repeat 3
npm run smoke:gate-auto
```

The eval script checks real model decisions. The smoke script drives the full pi-gate flow, including blocks and prompt fallback.

Auto decisions are logged to `.pi/state/pi-gate/auto-decisions.jsonl` with bounded summaries and hashes.

### Auto config

`auto.json` has three concepts:

- `hardDeny` — deterministic rules that always block
- per-agent/per-subagent `alwaysAllow` — optional deterministic shortcuts for boring, role-appropriate calls
- per-agent/per-subagent `guidance` — natural-language instructions for the local model

The runtime order is:

```text
policy/lineage deny?         -> block
hardDeny match?              -> block
alwaysAllow + low risk?      -> allow silently
otherwise                    -> ask local model with trusted story context
```

The local model returns `allow`, `block`, or `prompt`. `allow` approves one concrete tool call. `block` is a soft block so the agent can try a safer alternative. `prompt` asks the user in interactive top-level sessions and blocks unattended sessions.

`hardDeny` always wins over `alwaysAllow`. `alwaysAllow` is also checked by pi-gate's built-in risk guard before it can silently allow a call; risky secret/credential reads, external mutations, and similar guard-denied calls block instead of becoming silent deterministic allows. Shell chains only match `alwaysAllow` when every simple segment matches; pipes, redirects, command substitution, and backgrounding are not silently always-allowed.

Risk signals are still computed, included in the model context, and written to the audit log. For grey-area semantic review they are advisory rather than a separate user-facing policy layer, except sensitive-data and broad-destructive classifications, which remain deterministic safety floors. You can omit `alwaysAllow` entirely to send nearly all non-denied calls to the semantic approver; this is the recommended way to test the full auto flow.

For debugging, set `gate.auto.audit.includeDynamicPayloadText=true` to include the exact dynamic story sent to the approver in `.pi/state/pi-gate/auto-decisions.jsonl`. Leave this off by default because the story can include user text and bounded tool-input summaries.

If the auto runtime is unavailable or returns malformed output, pi-gate fails closed: ordinary unresolved calls prompt in interactive top-level sessions and block in unattended sessions.

## Actions

Rules resolve to one of:

- `allow`
- `ask`
- `deny`

## Matching

- wildcard matching is OpenCode-style
- `*` matches zero or more characters
- `?` matches exactly one character
- last matching rule wins
- profile overrides are appended after inherited rules, so child profile rules win naturally

## Profile inheritance

`profiles.<name>.inherits-from` may be:

- `$base` — inherit from the top-level `permission` block
- another profile name — inherit that profile, which itself can inherit from `$base` or another profile

If `inherits-from` is omitted, pi-gate treats it as `$base`.

Example:

```json
{
  "permission": {
    "edit": {
      "*": "ask"
    }
  },
  "profiles": {
    "docs": {
      "inherits-from": "$base",
      "permission": {
        "edit": {
          "*": "deny",
          "**/*.md": "allow"
        }
      }
    }
  }
}
```

## Subject mapping inside pi

pi-gate maps pi tools onto OpenCode-style permission subjects:

- `read` → `read`
- `write`, `edit`, `apply_migration` → `edit`
- `ls` → `list`
- `find` → `glob`
- `grep` → `grep`
- `bash` → `bash`

This means one `edit` rule governs file mutations across the mutation tools pi exposes.

## Bash behavior

Pi-gate is the authoritative control layer for bash permissions. Agent or subagent card metadata such as `bash: read-only` may express mode intent or add lightweight guardrails, but it is not a security boundary.

`bash` uses two layers:

1. command rule matching against the normalized command string
2. path-aware mutation checks for commands that modify files

If a bash command is mutating and pi-gate can extract target paths, it also evaluates:

- `external_directory`
- `edit`

This lets policies like `"**/*.md": "allow"` apply to both direct file tools and bash-based file mutation.

If a mutating command cannot be analyzed reliably, pi-gate asks instead of silently allowing it.

## Planner handoff file

By convention, Planner writes the definitive saved handoff plan to:

```text
${cwd}/.pi/plans/active.md
```

The `planner` gate profile allows edits only in that plan directory, while Builder should treat that file as the source of truth when it exists.

## Schema validation

`policy.schema.json` is the authoritative local schema during development.

Current recommendation:

```json
"$schema": "./policy.schema.json"
```

Later, when this is published, you can point `$schema` at the hosted GitHub URL.

At runtime, pi-gate validates the policy against the shipped schema and then performs extra semantic checks for things JSON Schema cannot express, including:

- unknown `inherits-from` targets
- circular inheritance
- invalid `activeProfile`

## Invalid policy behavior

If policy loading or validation fails, pi-gate fails closed: it warns in the UI, marks the footer as an error, and blocks tool calls until the policy is fixed.

Typical warning format:

```text
schema validation failed! <error-message>. Tool calls are blocked until the gate policy is fixed.
```

Status footer in that state:

```text
gate:error
```

## Runtime profile switching

You can switch profiles:

- manually via `/gate switch`
- per process via `GATE_PROFILE`
- from another extension via the event bus:

```ts
pi.events.emit("gate:switch-profile", {
  profile: "planner",
  notify: true,
  source: "agent-mode",
});
```

If pi is idle, the switch happens immediately.
If a turn is active, the switch is queued until `agent_end`.

License: MIT

Jude Payne, 2026
