# Review contract

## Target and state

- Open visible `experience: "chat"`.
- Snapshot the current visible setting.
- Apply and strictly verify `intelligence: "Pro"` before submission.
- Submit once; persist the thread URL immediately.
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

Resume with the same thread URL and archive directory. The workflow reloads the original packet manifest, configuration snapshot, and artifact baseline from the archive.

One workflow invocation performs one bounded polling call by default, then returns `in_progress`. Keep that default in browser-hosted execution. `maxPollCallsPerInvocation` is an explicit local ceiling, not permission to exceed the host call budget.

The calling agent owns cross-invocation backoff for each archive: 30 seconds, 60 seconds, 2 minutes, 4 minutes, then a maximum frequency of once every 5 minutes while consecutive results remain `in_progress`. A delegated subagent follows the same schedule. Wait outside browser-host calls; never immediately loop or hold the browser bridge open just to delay. This cadence is intentionally an agent contract rather than an SDK-enforced timer.

## Result interpretation

- `completed`: full requested contract succeeded.
- `completed_with_warnings`: the request completed, but inspect every warning.
- `in_progress`: generation continues; resume, never resubmit.
- `blocked`: user action, target uncertainty, sensitivity, fallback, or another fail-closed check prevented acceptance.
- `failed`: transport/archive/artifact correctness failed.

The raw `response.md` contains the captured answer.
