# subagent-mode

`subagent-mode` is the execution substrate behind delegated subagents in `picode`.

Most users should think of it as an internal engine rather than a feature they interact with directly.

Its job is to make delegated child execution reliable and inspectable.

---

## What it does

`subagent-mode` is responsible for:

- spawning child `pi --mode json -p` processes
- wiring session context for `fresh` and `fork` execution
- passing child model, thinking, tools, and system prompt settings through to the child runtime
- normalizing the child's JSON event stream into a stable event contract
- supporting sync and async execution
- persisting minimal async state for detached runs
- propagating delegation depth and run identity through nested delegation

This is the layer that makes `subagent-orchestrator` possible.

---

## What it does **not** do

`subagent-mode` does **not** provide a polished end-user UI.

It does not define:

- mode switching
- permission policies
- prompt vars UX
- run cards or handback UX
- user-facing prompt-line shorthand like `~scout`

Those belong to higher layers.

---

## Public shape

From a code point of view, `subagent-mode` provides:

- a run spec / event / result type surface
- a bridge between the Pi event bus and delegated child execution
- sync and async executors
- the per-child runner primitive

The key conceptual contract is:

```text
run spec → child process(es) → normalized events → structured run result
```

---

## Relationship to the rest of the package

### Called by `subagent-orchestrator`

The orchestrator decides *what* to run and *how to surface it*.

`subagent-mode` decides *how to execute it safely and consistently*.

### Uses child extension composition

Child runs are launched with an explicit extension set so the child environment contains the pieces it needs.

### Propagates depth and identity

It carries delegation identity through environment variables so nested delegation can still be tracked as a tree instead of degenerating into unrelated child runs.

---

## Should you use it directly?

Usually, no.

If you are an end user or package author, the feature you probably want is `subagent-orchestrator`.

`subagent-mode` becomes useful directly only if you are deliberately building another orchestration layer or another extension that needs the same child-runner substrate.

For normal use, think of it as a well-factored internal dependency.
