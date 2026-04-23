# Recipe: building a custom subagent team

This example shows how to build a staged PR-management workflow on top of picode using:

- **Builder** as the user-facing coordinator
- a custom **team-lead** subagent as the delegated workflow manager
- nested **scout**, **worker**, and **reviewer** subagents for specialist work
- explicit `context: "continue"` + `childSessionId` to resume the same delegated child thread across checkpoints

It is meant as a realistic demonstration of:

- nested delegation
- asynchronous launches
- explicit parent/user checkpoints
- agent-side continuation of a specific delegated child session

## The pattern

This version has three parties:

1. **User ↔ Builder** — the human conversation, approvals, and steering
2. **Builder ↔ team-lead** — staged delegated workflow via explicit `childSessionId` continuation
3. **team-lead ↔ nested subagents** — bounded specialist work such as scouting, implementation, and review

That split matters. The team-lead does not stop and talk directly to the user. Instead, it hands back a stage result to Builder, Builder asks the user what to do next, and then Builder resumes the same team-lead thread with `context: "continue"`.

## Stage flow

A good PR workflow looks like this:

1. **Assess** — Builder launches `team-lead` fresh. The team-lead inspects the PR, may fan out one or more `scout` subagents, and then stops with an assessment handback.
2. **Checkpoint** — Builder asks the user for a decision: go, reshape, or stop.
3. **Plan** — Builder resumes the same team-lead child session with `context: "continue"` and a task such as “User approved. Produce the plan and stop for plan approval.”
4. **Execute** — after plan approval, Builder resumes the same team-lead thread again. The team-lead fans out `worker` subagents in parallel by subsystem or file group.
5. **Review** — the team-lead runs one or more `reviewer` subagents over the combined diff, then hands back a final result.

This gives you a genuine nested team without losing the human checkpoint model that picode expects.

## The team-lead subagent

The team-lead is a custom subagent card with `delegate_subagent` in its tool set and `maxSubagentDepth: 2` so it can orchestrate downstream subagents. Its prompt should be written as a staged workflow manager:

- do one stage at a time
- return a structured handback at the end of each checkpoint stage
- never try to ask the user directly
- expect Builder to resume the same child session with `context: "continue"`

In other words, the team-lead owns the workflow logic, but Builder still owns the user conversation.

See `../team-lead.md` for the example card.

## The supporting skill

The skill teaches Builder when to invoke the team-lead, what information to pass in, how to extract and remember the returned `childSessionId`, what checkpoint question to ask the user, and when to resume the workflow with explicit continuation.

That is the key difference from a simple one-shot subagent skill: the skill is not just a trigger, it also teaches the parent agent how to manage the staged handback-and-continue loop.

See `./SKILL.md` for the example skill.

## A concrete continuation example

A Builder-style flow might look like this:

```text
1. Launch `team-lead` async to assess the PR.
2. Read the returned `childSessionId` from the run details.
3. Ask the user: go / reshape / stop?
4. Resume the same child with:
   delegate_subagent({
     agent: "team-lead",
     context: "continue",
     childSessionId: "...",
     task: "User approved. Produce the plan and stop for approval."
   })
5. Ask the user to approve the plan.
6. Resume the same child again for execute + review.
```

## Installing it

1. Save `team-lead.md` to your subagents overlay directory (configured in `.pi/settings.json`)
2. Save the `pr-management/` skill directory under your skills path (`.pi/skills/` or `~/.pi/agent/skills/`)
3. Make sure the current top-level agent is allowed to delegate to `team-lead`
4. Run `/reload`
5. Ask Builder to use the PR-management workflow on a concrete PR task

Working copies live in:

- `examples/team-lead.md`
- `examples/pr-management/SKILL.md`
- `examples/pr-management/README.md`
