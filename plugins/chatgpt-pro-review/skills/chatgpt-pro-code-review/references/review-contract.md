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

Treat `in_progress` as durable state:

```json
{
  "status": "in_progress",
  "submitted": true,
  "resubmitAllowed": false,
  "nextAction": "poll_same_thread"
}
```

Resume with the same thread URL and archive directory. The immutable submission receipt binds the original prompt, local and upload manifests, every packet size/hash, configuration snapshot, artifact baseline, canonical conversation, and stable tab metadata when available. Resume verifies those bindings before browser contact. A non-resumable target/fallback outcome is recorded durably and cannot later be accepted by resuming the archive.

Treat a provisional `WEB:` ID as a route hint, not a canonical conversation.
Adopt a canonical ID only after exact archived-prompt ownership and submission
evidence are proven. Claim an exact already-open tab before navigation. Require
a unique prompt-identical recovery candidate; use the archived tab ID only as a
stable discriminator, and return `review_thread_recovery_ambiguous` when
multiple candidates remain. Never guess or open a duplicate replacement chat.

Publish terminal archive state in order: write configuration, redacted report,
and receipt provenance first. For a non-resumable blocker, publish
`terminal-outcome.json` last. If the provenance commit fails, return
non-resumable `archive_terminal_commit_failed` and persist
`archive-commit-failure.json` as the authoritative resume marker when possible.

One workflow invocation performs one bounded polling call by default, then returns `in_progress`. Keep that default in browser-hosted execution. `maxPollCallsPerInvocation` is an explicit local ceiling, not permission to exceed the host call budget.

The calling agent owns cross-invocation backoff for each archive: 30 seconds, 60 seconds, 2 minutes, 4 minutes, then a maximum frequency of once every 5 minutes while consecutive results remain `in_progress`. A delegated subagent follows the same schedule. Wait outside browser-host calls; never immediately loop or hold the browser bridge open just to delay. This cadence is intentionally a clear agent contract rather than an SDK-enforced timer, so direct SDK callers are not artificially delayed. The archive lease uses an immutable generation marker whose filesystem timestamp is renewed during a live invocation. Direct proof that the owner process is live is authoritative and keeps the lease locked regardless of age. Only after a durable receipt proves the review was submitted and cannot be resubmitted, and only when PID liveness is unavailable or ambiguous, may the heartbeat act as an availability fallback: the lease can be reclaimed after five full minutes without renewal. Pre-submit archives remain fail-closed. Cleanup rechecks the generation marker so a delayed invocation cannot delete a successor's lease.

## Result interpretation

- `completed`: full requested contract succeeded.
- `completed_with_warnings`: the request completed, but inspect every warning.
- `in_progress`: generation continues; resume, never resubmit.
- `blocked`: user action, target uncertainty, sensitivity, fallback, or another fail-closed check prevented acceptance.
- `failed`: transport/archive/artifact correctness failed.

`conversation_binding_lost`, `conversation_tab_affinity_lost`, and
`conversation_prompt_affinity_lost` preserve the original conversation rather
than rebinding silently. Post-submit affinity blockers are resumable from the
same archive and remain non-resubmittable; a pre-submit binding loss requires a
fresh request.

The raw `response.md` contains the captured answer.
