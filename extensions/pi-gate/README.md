# pi-gate

Permission gate for pi with an OpenCode-compatible policy format, profile inheritance, and path-aware bash checks.

## Files

- `index.ts` — extension entrypoint
- `policy.json` — active policy
- `policy.schema.json` — JSON Schema for `policy.json`
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

## Commands

- `/gate` — show status
- `/gate status` — show status
- `/gate switch` — picker for available profiles
- `/gate clear` — clear cached session approvals
- `/gate auto status` — show local auto-approver status
- `/gate auto on` — explicitly enable local auto-approval for ask decisions
- `/gate auto off` — disable auto-approval and stop the managed runtime

## Policy format

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

## Local auto-approval

Normally, when a rule resolves to `ask`, pi-gate asks you what to do. Local auto-approval is an optional way to make those moments quieter: a small local model reviews the single tool call first.

The important rules are simple:

- hard `deny` still means deny; the model never overrides it
- hard `allow` still means allow; the model is not involved
- auto-approval only handles `ask`
- a model approval is for one concrete tool call only
- risky or unclear calls are blocked first so the agent can try a safer approach
- after repeated blocks, pi-gate pauses auto mode and asks you

When auto is active, the footer shows `gate:<profile> auto`.

### Quick setup

You need two local things:

1. `llama-server` from llama.cpp
2. a GGUF model file, such as `MiniCPM5-1B-Q4_K_M.gguf`

This package does not bundle either one. You own where they are installed and cached.

If you want the helper to download and verify the default model, run:

```sh
node scripts/setup-gate-auto-approver.mjs
```

The helper:

- downloads/verifies the default MiniCPM5-1B Q4 GGUF model
- looks for `llama-server`
- prints the `/vars set ...` commands to run in Pi
- prints `/gate auto on`

By default, the helper stores model files under:

1. `$PICODE_GATE_AUTO_HOME`, if set
2. `$HF_HOME/picode/gate-auto-approver`, if `HF_HOME` is set
3. `~/.pi/picode/gate-auto-approver` otherwise

You can override that with `--install-dir`.

If you already manage models yourself, skip the helper and set the paths directly:

```text
/vars set gate.auto.llama.serverPath "/path/to/llama-server"
/vars set gate.auto.llama.modelPath "/path/to/MiniCPM5-1B-Q4_K_M.gguf"
/vars set gate.auto.timeoutMs 1500
/gate auto on
```

### Using it

Use these commands in Pi:

```text
/gate auto on      # start auto-approval for this session
/gate auto off     # stop it
/gate auto status  # inspect status and paths
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

### External server mode

Instead of letting pi-gate start `llama-server`, you can run your own local server and point pi-gate at it:

```text
/vars set gate.auto.llama.endpoint "http://127.0.0.1:8080"
/gate auto on
```

Only local loopback HTTP endpoints are accepted.

### Testing

After setup, you can run:

```sh
node scripts/eval-gate-auto-approver.mjs --repeat 3
npm run smoke:gate-auto
```

The eval script checks real model decisions. The smoke script drives the full pi-gate flow, including soft-blocks and the repeated-block fallback prompt.

Decisions are logged to `.pi/state/pi-gate/auto-approvals.jsonl` with bounded summaries and hashes.

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
