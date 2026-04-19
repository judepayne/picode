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
- falls back to **YOLO permission mode** if policy loading or validation fails

## Commands

- `/gate` — show status
- `/gate status` — show status
- `/gate switch` — picker for available profiles
- `/gate clear` — clear cached session approvals

## Policy format

`policy.json` is intentionally close to OpenCode.

Top-level keys:

- `$schema`
- `activeProfile`
- `permission`
- `profiles`

`activeProfile` is the profile pi-gate uses on startup and after `/reload`, unless it is overridden by `GATE_PROFILE` or explicitly switched at runtime.

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

## YOLO permission mode

If policy loading or validation fails, pi-gate does not enforce anything.

Instead it warns in the UI and switches to YOLO mode.

Typical warning format:

```text
schema validation failed! <error-message>. You're currently in YOLO permission mode!
```

Status footer in that state:

```text
gate:yolo
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
