---
name: pr-management
description: Use the team-lead subagent to process PRs from assessment through review. Invoke when the user mentions a PR, diff, or wants to delegate a multi-file change end-to-end.
---

# PR Management

Use the `team-lead` subagent when the user wants to:
- Assess and implement a PR
- Delegate a multi-file change end-to-end
- Get a structured review of an existing PR

## Invocation

Call the team-lead with a clear task:

```text
~team-lead Assess PR #123: the auth refactor. Check the diff, ask me for go/no-go, then plan and execute.
```

Or through the active agent:

```text
Have the team-lead process this PR from assessment through review.
```

## Expected handback

The team-lead returns a structured summary:
- Assessment summary
- User decisions made
- Execution status per subsystem
- Review findings by severity
- Remaining work or blockers

## Workflow stages

The team-lead manages these stages automatically. You do not need to call each subagent yourself:

| Stage | Subagent | When it runs |
|-------|----------|-------------|
| Assess | team-lead itself | Always |
| Reshape | Designer | Only if user asks |
| Plan | Planner | After go/no-go |
| Execute | Worker(s) | After plan, in parallel |
| Review | Reviewer(s) | After execution |

## Guidelines

- Provide the PR number, branch name, or diff context in the initial task
- The team-lead will stop at user checkpoints; do not pre-approve stages
- If a worker fails, the team-lead stops and reports the failure
- If review finds critical issues, the team-lead stops and asks the user
