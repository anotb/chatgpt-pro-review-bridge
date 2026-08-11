# Review contract

## Target and state

- Open visible `experience: "chat"`.
- Snapshot the current visible setting.
- Apply and strictly verify `intelligence: "Pro"` before submission.
- Submit once; persist the thread URL immediately.
- Poll bounded metadata only. Read complete Markdown once after completion.
- Reinspect Pro and scan visible fallback/unavailability evidence before accepting the answer.
- Restore and strictly verify the prior setting in `finally`.

Treat `in_progress` as durable state:

```json
{
  "status": "in_progress",
  "submitted": true,
  "resubmitAllowed": false,
  "nextAction": "poll_same_thread"
}
```

Resume with the same thread URL and archive directory. The workflow reloads the original packet manifest, configuration snapshot, and artifact baseline from the archive.

One workflow invocation performs one bounded polling call by default, then returns `in_progress`. Keep that default in browser-hosted execution. `maxPollCallsPerInvocation` is an explicit local ceiling, not permission to exceed the host call budget.

## Result interpretation

- `completed`: full requested contract succeeded.
- `completed_with_warnings`: review completed, but inspect every warning; restoration failure makes `ok` false.
- `in_progress`: generation continues; resume, never resubmit.
- `blocked`: user action, target uncertainty, sensitivity, fallback, or restoration prevented acceptance.
- `failed`: transport/archive/artifact correctness failed.

The raw `response.md` is authoritative. `findings.json` exists only when the optional JSON appendix parsed completely.
