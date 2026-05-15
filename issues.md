# Review Issues: Medium and Low

## Medium

All medium findings from the release review have been addressed or explicitly resolved:

- **Agent overlay paths likely resolve contrary to docs** — fixed. Project `.pi/settings.json` overlay paths now resolve relative to the project root; global settings keep their existing settings-file-relative behavior. Tests updated.
- **Prompt-vars auto-bootstrap can shadow global defaults** — fixed. Project bootstrap no longer seeds `paths.plan` / `paths.design` when corresponding global values already exist. Regression test added.
- **Async cancellation startup race** — fixed in the PID-based cancellation work. Startup-race fallback is explicit and verified paths remain guarded.
- **Unbounded stdout line buffering** — fixed. Child stdout JSONL line buffering is capped and oversized lines are discarded with a nonfatal child error; normal parsing resumes after the next newline.
- **Async event persistence ignores stream backpressure** — fixed. Sync execution callbacks can now be async, runner event forwarding awaits them, and async event persistence waits for `drain` when the events stream backpressures.
- **`curl*` in read-only bash guard is too broad** — fixed. The lightweight read-only bash allow-list no longer treats arbitrary `curl` commands as read-only; regression coverage added for `curl ... -o`.

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
