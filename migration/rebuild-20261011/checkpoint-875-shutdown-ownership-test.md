# Checkpoint 875: deterministic shutdown ownership regression

2026-10-14 UTC. Follow-up to checkpoint 874 WIP; scoped verification only, not migration or deployment PASS.

The failing aggregate Background-worker count assumed no periodic discovery worker could remain during abort. Source ownership permits discovery and startup completion to coexist, and both retain slots until native exit. The archived failing run does not identify the second worker directly.

Test-only repair records the exact CompleteContext slot and operation signal. An explicit atomic release barrier replaces the 300 ms fault delay; the finally path always releases it. The test requires cancellation to reach that operation while its slot, runner admission and both mapping locks remain held. It retains the single completion/revision, original uncertainty and final zero-worker/lock checks. Production code is unchanged by this checkpoint.

Verified on pinned Node 24.21.0 with emitted JavaScript and --no-strip-types:
- Previous seven-file regression selection: 103/103 passed, zero failed/cancelled/skipped.
- Bootstrap worker/coordinator selection: 46/46 passed.
- Local profile/CLI selection: 13/13 passed.
- Repaired shutdown case: five additional isolated repetitions passed.
These runs overlap and must not be summed into distinct coverage totals. Strict TypeScript, production build, emitted test-profile build and diff checks passed. Independent two-file read-only review found no remaining P1/P2.

Checkpoint 874's recorded failure is resolved for this tested revision. Full singleton application launch remains unverified (Unix socket EPERM), as do live Discord/Codex, production stores, Windows behavior, external producer qualification, performance and long-duration acceptance. CLI mirror enablement remains gated. No protected redaction fixture, actual database, raw log, secret or generated output is included.
