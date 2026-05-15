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

All low findings from the release review have been addressed or explicitly resolved:

- **Pi-gate schema validator does not enforce boolean type** — fixed. The local schema validator now supports `type: "boolean"`, and a regression test rejects string `unattended` values.
- **Pi-gate README mismatch around invalid policy behavior** — fixed. The README now documents the current fail-closed `gate:error` behavior instead of YOLO fallback.
- **Async detached launch path under-tested** — improved. The detached async runner spawn command/options are now factored into a pure helper with regression coverage for `jiti async-runner-main.ts <cfg>` launch shape.
- **Missing regression tests for risky orchestrator paths** — revisited. Existing coverage now includes disabled-by-default `dev_subagent_stream_to_file`, explicit env-flag registration, async cancel already-finished behavior, and async event ingestion after launch/reload-like tailing paths.
- **Docs mismatch around `/vars bootstrap` and auto-bootstrap** — fixed. Root and z-prompt-vars docs now describe session-start auto-bootstrap, project/global file creation, and preservation of global plan/design defaults.
- **Installed package skill path references may be fragile** — fixed. Built-in agent cards now reference registered skill names instead of repo-relative `skills/.../SKILL.md` paths.
