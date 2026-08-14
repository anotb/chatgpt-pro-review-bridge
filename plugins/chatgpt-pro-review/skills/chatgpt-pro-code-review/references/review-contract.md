# Review contract

## Target and state

- Open visible `experience: "chat"`.
- Snapshot the current visible setting.
- Apply and strictly verify `intelligence: "Pro"` before submission.
- Submit once; persist the thread URL immediately.
- Bind the invocation to its canonical conversation and visible browser tab before attachment or submission, then recheck that affinity through polling, response capture, post-completion verification, and artifact handling.
- Poll bounded metadata only. Read complete Markdown once after completion.
- Reinspect Pro and scan visible fallback/unavailability evidence before accepting the answer.
- Leave Chat on Pro by default. Restore a prior setting only when the caller explicitly opts in.

The usual confirmed `in_progress` result is durable state:

```json
{
  "status": "in_progress",
  "submitted": true,
  "resubmitAllowed": false,
  "nextAction": "poll_same_thread"
}
```

Require `resubmitAllowed: false` for every same-archive recovery. Use durable phase, not `submitted: false` alone, to decide what a resume may do:

- A validated `pre-submit-checkpoint.json` with no intent or receipt may continue to the first and only submit.
- `submission-intent.json` means submission may already have been attempted. Reconcile the visible thread; never submit again.
- A confirmed receipt with `submitted: true` resumes only the existing response.

Intent or receipt takes precedence over a checkpoint. Resume the same archive and let the workflow validate that phase's bindings before browser contact. A receipt binds the original prompt, manifests, packet hashes, configuration, artifact baseline, canonical conversation, and stable tab metadata. A non-resumable outcome remains non-resumable.

Treat a provisional `WEB:` ID as a route hint, not a canonical conversation.
Adopt a canonical ID only after exact archived-prompt ownership and submission
evidence are proven. Claim an exact already-open tab before navigation. Require
a unique prompt-identical recovery candidate; use the archived tab ID only as a
stable discriminator, and return `review_thread_recovery_ambiguous` when
multiple candidates remain. Never guess or open a duplicate replacement chat.

`existing_tab_handoff_completed` ends the current task turn: handoff must be
its final browser action. Resume the same archive once from a later turn and a
fresh browser-host invocation. Never reuse the old client or submit in the
handoff turn; the phase rules above still apply.

Publish terminal archive state in order: write configuration, redacted report,
and receipt provenance first. For a non-resumable blocker, publish
`terminal-outcome.json` last. If the provenance commit fails, return
non-resumable `archive_terminal_commit_failed` and persist
`archive-commit-failure.json` as the authoritative resume marker when possible.

One workflow invocation performs one bounded polling call by default, then returns `in_progress`. Keep that default in browser-hosted execution. `maxPollCallsPerInvocation` is an explicit local ceiling, not permission to exceed the host call budget.

Give a fresh file-backed browser-host call a 5–10 minute outer envelope. `callTimeoutMs` bounds only each post-submit metadata poll. An outer timeout preserves the archive and tabs and never authorizes resubmission.

The calling agent owns post-submit backoff in prose: 30 seconds, 60 seconds, 2 minutes, 4 minutes, then no more than once every 5 minutes while generation continues. Wait outside the SDK; it enforces no delay. A tab handoff is not a polling result. The archive lease uses an immutable generation marker whose filesystem timestamp is renewed during a live invocation. Direct proof that the owner process is live is authoritative and keeps the lease locked regardless of age. Only after a durable receipt proves the review was submitted and cannot be resubmitted, and only when PID liveness is unavailable or ambiguous, may the heartbeat act as an availability fallback: the lease can be reclaimed after five full minutes without renewal. Pre-submit archives remain fail-closed. Cleanup rechecks the generation marker so a delayed invocation cannot delete a successor's lease.

## Result interpretation

- `completed`: full requested contract succeeded.
- `completed_with_warnings`: the request completed, but inspect every warning.
- `in_progress`: work remains; follow the durable phase rules above.
- `blocked`: user action, target uncertainty, sensitivity, fallback, or another fail-closed check prevented acceptance.
- `failed`: transport/archive/artifact correctness failed.

`conversation_binding_lost`, `conversation_tab_affinity_lost`, and
`conversation_prompt_affinity_lost` preserve the original conversation rather
than rebinding silently. Post-submit affinity blockers are resumable from the
same archive and remain non-resubmittable; a pre-submit binding loss requires a
fresh request.

The raw `response.md` contains the captured answer.
