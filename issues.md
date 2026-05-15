# Review Issues: Medium and Low

## Medium

### Agent overlay paths likely resolve contrary to docs

`extensions/agent-assets/config.ts`

Overlay directory paths from `.pi/settings.json` are resolved relative to the settings file directory (`<cwd>/.pi`), while docs imply paths such as `./custom-agents` are relative to the project root. Tests currently encode the workaround with `../custom-agents`, so the documented path is not validated.

### Prompt-vars auto-bootstrap can shadow global defaults

`extensions/z-prompt-vars/index.ts`
`extensions/z-prompt-vars/prompt-vars.ts`

Automatic session bootstrap creates project-local default `paths.plan` and `paths.design`. Since project vars override global vars, a user with global plan/design paths but no project vars can have those global defaults shadowed unexpectedly.

### Async cancellation startup race

`extensions/subagent-mode/async-executor.ts`
`extensions/subagent-mode/orchestrator-bridge.ts`

Immediate cancellation before the async child writes `run.json` can miss the persisted PID path. This was addressed in the recent PID-based cancellation work, but remains listed here as an original medium finding for tracking/history.

### Unbounded stdout line buffering

`extensions/subagent-mode/runner.ts`

A large JSONL event or output stream without newlines can accumulate unbounded data in the stdout line buffer until newline or close. This can cause memory pressure from malformed or unusually chatty child output.

### Async event persistence ignores stream backpressure

`extensions/subagent-mode/async-executor.ts`

Async event writes ignore the return value of `eventsStream.write(...)`, so a very chatty detached child can queue unbounded writes. The existing JSONL writer abstraction suggests this may have been intended to handle backpressure.

### `curl*` in read-only bash guard is too broad

`extensions/agent-mode/index.ts`

The mode-level `bash: read-only` guard allows broad command prefixes such as `curl*`, including forms that can write files. This has since been reframed as a lightweight guardrail rather than a security boundary, with pi-gate as the authoritative control layer.

## Low

### Pi-gate schema validator does not enforce boolean type

`extensions/pi-gate/index.ts`
`extensions/pi-gate/policy.schema.json`

The local schema validator models only object/string type checks, while the schema declares fields such as `profiles.*.unattended` as boolean. An invalid value like `"true"` may pass local validation and behave unexpectedly.

### Pi-gate README mismatch around invalid policy behavior

`extensions/pi-gate/README.md`

Docs say invalid policy falls back to YOLO/no enforcement, but current code blocks tool calls until the policy is fixed. The README should be updated or the implementation intentionally changed.

### Async detached launch path under-tested

`extensions/subagent-mode/test/...`

Tests do not fully exercise the detached `jiti async-runner-main.ts <cfg>` launch path. Existing tests mostly validate in-process async runner behavior and availability checks.

### Missing regression tests for risky orchestrator paths

`extensions/subagent-orchestrator/test/`

Original review called out missing tests for post-reload async cancellation and `dev_subagent_stream_to_file` path restrictions/exposure. Some coverage was added during the recent fixes, but this should be revisited for completeness.

### Docs mismatch around `/vars bootstrap` and auto-bootstrap

`README.md`
`extensions/z-prompt-vars/index.ts`

README says `/vars bootstrap` creates project-local files, but the extension also auto-bootstraps on session start and may create global vars. This may surprise users and should be documented more explicitly.

### Installed package skill path references may be fragile

`extensions/agent-assets/agents/*.md`

Agent cards reference repo-relative skill paths such as `skills/.../SKILL.md`. In installed package contexts, those paths may not be under the user’s current working directory even though skills are registered via `pi.skills`; skill-name references may be safer.
