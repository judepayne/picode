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

`pi-gate` can optionally mediate `ask` decisions through a local llama.cpp approver. Hard `allow` and hard `deny` are unchanged; hard deny is never model-overridable. A model `allow` approves one concrete tool call only and never creates an `Allow for session` entry.

Enablement is explicit and project-scoped:

```text
/gate auto on
/gate auto off
/gate auto status
```

`/gate auto on` writes `gate.auto.enabled=true` through the protected z-prompt-vars helper and starts auto approval for the current Pi session. Generic `/vars set gate.auto.enabled true` is rejected. `/gate auto off` writes project `false` and stops any managed `llama-server` owned by this process.

Auto approval does not start by default after a fresh Pi start, even when the project has previously been enabled. Users who want opt-in autostart for a project can set `gate.auto.startOnSession=true`.

Config keys:

```text
gate.auto.startOnSession=false                 # true to auto-start after Pi restart
gate.auto.llama.endpoint=http://127.0.0.1:8080 # optional external server
gate.auto.llama.serverPath=/path/to/llama-server # managed mode
gate.auto.llama.modelPath=/path/to/MiniCPM5-1B-Q4_K_M.gguf
gate.auto.timeoutMs=1500
gate.auto.llama.warmup=true
gate.auto.audit.enabled=true
```

If no endpoint is configured, the top-level process can launch a managed `llama-server` when `serverPath` and `modelPath` are set. Delegated subagents inherit the top-level endpoint through reserved `PI_GATE_AUTO_*` environment metadata and do not spawn their own server by default.

Fallback matrix:

- model `allow` → allow this call once, unless deterministic risk flags downgrade it
- model `deny` or guarded `escalate` → soft-block the call and return the reason to the agent so it can try a safer alternative
- after 3 consecutive or 20 total auto-blocks, top-level interactive sessions pause auto mode and prompt the user; approving a prompted action resumes auto mode
- timeout, malformed output, or unavailable endpoint → human prompt when interactive, otherwise block

The model receives compact stable context plus a per-call `riskAssessment`. Deterministic guards keep secrets, broad destructive actions, package-manager changes, network/remote access, privilege escalation, opaque/unknown commands, and unclassified non-readonly bash from being silently auto-allowed even if the model is too permissive.

When enabled, the footer shows `gate:<profile> auto`, with `auto` in golden yellow. Successful auto approvals are quiet. Decisions are logged to `.pi/state/pi-gate/auto-approvals.jsonl` with bounded summaries and hashes.

The package does not bundle llama.cpp or the GGUF model. Users own those local dependencies: install/provide `llama-server`, choose where model artifacts live, and pass `/vars set gate.auto.llama.*` paths. `node scripts/setup-gate-auto-approver.mjs` is only a helper: it downloads/verifies the default MiniCPM5-1B Q4 GGUF model, locates `llama-server`, and prints the `/vars set ...` commands. Its default artifact root is `$PICODE_GATE_AUTO_HOME`, else `$HF_HOME/picode/gate-auto-approver`, else `~/.pi/picode/gate-auto-approver`; `--install-dir` overrides it. The helper configures paths but does not make auto approval start automatically after every Pi restart; set `gate.auto.startOnSession=true` if you want that. Run `node scripts/eval-gate-auto-approver.mjs --repeat 3` to start the local model and exercise a fixed real-model decision suite, or `npm run smoke:gate-auto` for the full pi-gate soft-block harness.

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
