# Campaign Automation Testing

This folder stores mock simulation notes and results for the isolated
`campaign-automation` module.

Scope:
- no real telephony
- no real `/api/calls/start`
- no production bridge usage
- no live Supabase queue yet

Current simulations:
- baseline queue pressure with CPS and concurrency caps
- retry pressure with retryable outcomes and re-entry into the queue

Artifacts:
- `simulation-results.csv`: append-only summary of each simulation run

Notes from current runs:
- `baseline_100_patients_30s_calls` reached the full concurrency ceiling of 50
  without exceeding CPS or concurrency limits.
- `retry_100_patients_20s_calls` surfaced a timing-boundary edge case where one
  item remained in progress at the end of the loop.
- `retry_100_patients_20s_calls_corrected` reran the same retry scenario with a
  stricter terminal-state check and completed all 100 patients with no limit
  violations.
- `simulator_300_patients_5_to_10s_calls` used 300 fake patients with
  simulator-style 5-10 second call duration and retry handling; all rows
  completed with zero CPS or concurrency violations.
- private patient CSV removed from repo before GitHub push.
