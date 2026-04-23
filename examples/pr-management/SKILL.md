---
name: pr-management
description: Use the team-lead subagent to run a staged PR workflow. Invoke when the user mentions a PR, a diff, or wants to delegate a multi-file change end-to-end with explicit checkpoints.
---

# PR Management

Use the `team-lead` subagent when the user wants to:
- assess and implement a PR in stages
- delegate a multi-file change end-to-end
- checkpoint after assessment and planning before continuing

## Parent-agent role

In this workflow, the parent agent remains in charge of the user conversation.

The pattern is:
1. launch `team-lead`
2. receive a stage handback
3. ask the user for the decision
4. resume the same child with explicit continuation

The parent should not expect `team-lead` to talk directly to the user.

## First launch

Start the workflow with a fresh delegated run:

```text
Use the team-lead subagent to assess PR #123: the auth refactor. Read the diff and related code, return the assessment, and stop for my decision.
```

## Continuing the same workflow

When the team-lead hands back, note the returned `childSessionId` from the delegation details.

Then resume the same child explicitly, for example:

```json
{
  "agent": "team-lead",
  "context": "continue",
  "childSessionId": "<child-session-id>",
  "task": "User approved. Produce the implementation plan and stop for plan approval."
}
```

And later:

```json
{
  "agent": "team-lead",
  "context": "continue",
  "childSessionId": "<child-session-id>",
  "task": "Plan approved. Execute the plan, use workers in parallel where appropriate, then run review and return the final handback."
}
```

## Expected handback

Each team-lead stage should return:
- Stage
- Status
- Next
- Summary
- Artifacts
- Failures

The important point is that the handback tells the parent whether to ask the user something or continue the workflow.

## Nested team shape

The team-lead manages these stages internally:

| Stage | Who does it | Notes |
|-------|-------------|-------|
| Assess | team-lead + optional scouts | Returns assessment handback |
| Plan | team-lead + optional scouts | Returns plan handback |
| Execute | worker(s) | Can fan out in parallel |
| Review | reviewer(s) | Returns final verdict |

## Guidelines

- Provide the PR number, branch name, or diff context in the initial task
- Do not pre-approve later stages in the first launch
- Treat the user checkpoints as parent-agent responsibilities
- If a nested worker fails, the team-lead should stop and report it
- If review finds serious issues, the parent should decide whether to continue the same thread or stop
