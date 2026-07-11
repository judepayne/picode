---
name: partner-reviewer
description: Run the bounded Partner Reviewer workflow for implementations that changed five or more unique files.
---

# Partner Reviewer Workflow

Use this skill only when Builder's Partner Reviewer instruction applies. For that implementation packet, this workflow replaces the ordinary one-pass review policy.

## Trigger

Treat one user-requested implementation as one review packet.

Use Partner Reviewer when the current implementation changed five or more unique files. Determine this from the files changed during implementation; do not routinely run a separate counting command.

If the count is genuinely unclear at the final review decision point, you may verify it once. For example:

```bash
{ git diff --name-only --diff-filter=ACMRTUXB; git ls-files --others --exclude-standard; } | sort -u | wc -l
```

This command can include pre-existing user changes, so it is a fallback rather than the primary source of the count. Every implementation-touched path counts; do not exclude file types or reinterpret the threshold.

## Initial review

After implementation and focused validation are complete, launch one Partner Reviewer asynchronously:

```json
{
  "agent": "partner-reviewer",
  "task": "Perform the initial full review of the completed working-tree diff. Use the active design and plan as implementation intent, report findings by severity, and return an explicit clean, acceptable, or changes-required verdict.",
  "context": "fresh",
  "async": true,
  "showRunCard": false
}
```

Include the concrete active design and plan paths in the task when they exist. Do not mutate reviewed files while the review is active. Follow the normal async handback rules: do not add a redundant launch acknowledgement, and answer using the completion result when it arrives.

Retain the latest returned `childSessionId` for this Partner Reviewer thread.

- `clean` or `acceptable`: close the review workflow.
- `changes-required`: address material findings, use judgment on Low findings, and run focused validation before closure review.

Do not also launch the ordinary `reviewer` for this packet.

## Closure review

Resume the same Partner Reviewer with one single-task asynchronous continuation:

```json
{
  "agent": "partner-reviewer",
  "task": "Perform the targeted closure review. Re-read the current diff, verify the remediation of every prior material finding, check for concrete remediation regressions, and return an explicit clean, acceptable, or changes-required verdict.",
  "context": "continue",
  "childSessionId": "<latest-child-session-id>",
  "async": true,
  "showRunCard": false
}
```

Use the concrete latest `childSessionId`; there is no implicit continue-latest operation. Do not mutate reviewed files while the closure review is active.

- `clean` or `acceptable`: close the thread.
- unresolved Critical/High findings: remediate, validate, and permit one final targeted continuation.
- other remaining findings after closure: report them and stop rather than looping.

Low findings never keep the review cycle open. The parent agent remains accountable for remediation choices, validation, and the final user response.
