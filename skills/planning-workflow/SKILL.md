---
name: planning-workflow
description: Use a structured planning workflow to produce an implementation-ready Builder handoff grounded in the actual repository.
---

# Planning Workflow

Use this skill when you need to produce or refine an implementation plan.

## Goal

Turn the request into a Builder-ready plan grounded in the repository as it exists now.

## Default posture

- inspect before concluding
- keep source code read-only
- ask 1-3 focused planning questions before finalizing unless the answers would not change the plan
- use subagents for reconnaissance, not for the planning judgment
- if the prompt already names an active plan or design file, treat those as the authoritative artifacts

## Workflow

### 1. Frame the task
- restate the request in precise technical terms
- identify the goal, constraints, likely validation, and the files or subsystems most likely involved

### 2. Inspect the code
- read the relevant entry points, types, configuration, tests, and nearby call paths
- prefer targeted inspection over broad scanning
- if the scope spans multiple subsystems or patterns, use 1-3 exploratory subagents in parallel
- use a chain only when later reconnaissance depends on earlier findings

### 3. Clarify
Ask brief questions only where the answers would materially change:
- scope
- sequencing
- migration behavior
- validation expectations
- non-goals
- compatibility constraints

If you skip questions, say explicitly why they would not change the plan.

### 4. Design the plan
For each impacted file or area, capture:
- what changes
- why it belongs there
- dependencies or sequencing constraints
- risks, edge cases, or likely failure modes
- what was verified directly versus inferred

Consider alternatives only when there is a real design choice.

### 5. Validate the plan
Before finalizing:
- re-read the highest-risk files
- check the plan against the user's request
- make it can be executed it without reinterpretation
- ensure validation steps are included
- Does the documentation need to change? If so, include those steps

### 6. Produce the handoff
The final handoff should usually include:
- a short summary
- assumptions or open questions
- ordered implementation steps
- file-by-file impacts
- validation steps
- rollout or migration notes when relevant

For larger work (more than half a day's work), split the plan into phases.

## Output

- In chat, either ask the focused questions or present the final plan.
- In the saved plan file, keep the definitive Builder handoff version.

## Stop conditions

- If the user wants implementation now, stop and suggest an implementation mode.
- If the task is still under-shaped and needs architecture or interface work, suggest a design mode.
- If the user wants review of existing code rather than a forward plan, suggest a review mode.
