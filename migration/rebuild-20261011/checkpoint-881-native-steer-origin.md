# Checkpoint 881: bounded native ordinary Steer origin

2026-10-15 UTC. RuntimeCommandExecutor now installs one fixed-database NativeSteerOriginWriter in its ordinary PromptControlActions path. The original ingress key, event and actor are captured before target-selection awaits and carried unchanged into the native operation together with the exact target, turn, generation, prompt and timestamp. These values correlate to existing admission; the writer neither creates a new admission nor substitutes a later request. The caller retains the original ingress custody and shared target lock.

This is a bounded migration slice, not a whole-runtime, performance, Windows or deployment PASS. Checkpoint880's installed native Settings/lifecycle reads are preserved. Its other ten frozen source/test files are byte-for-byte unchanged.

## Storage and ownership

The worker opens only an existing SQLite database, with a 100 ms busy timeout and foreign-key enforcement unchanged from the existing adapter's disabled profile. It owns a short BEGIN IMMEDIATE transaction, verifies the current catalog, invokes the original recordOrigin primitive, commits, and closes before acknowledgement. It never initializes, repairs, migrates or creates a database and never changes journal or synchronous settings. Original Rust whitespace trimming, SHA-256 marker spelling, Unicode and INSERT OR IGNORE first-timestamp semantics remain shared with the legacy implementation. The store wrapper also preserves the borrowed primitive's nonfinite timestamp behavior; the production custody clock continues requiring finite nonnegative timestamps.

The parent uses the existing shared Control1 lane and zero waiting queue. Saturation is explicit pre-submission refusal. Every submitted write joins real native exit on cancellation, timeout, error or a synchronous submission-return failure. SQLite is never terminated to manufacture completion. Private signal forwarding avoids caller hooks during slot setup/exit, and the original native signal state is checked after joining, including suppressed abort events and later method replacement.

An acknowledgement must have exactly the original request ID, pinned path, operation, ingress/event/actor, target/turn/generation, timestamp and computed marker, plus successful status. It is validated only after native exit. Missing, crossed, malformed or lost acknowledgement is Unknown, including possible commit, rollback, cancellation and deadline. One bounded unresolved original is retained in the installed writer; all later ordinary Steer attempts fail with that same uncertainty before target reads or another write. No synchronous fallback, replacement admission, outbound control or automatic replay follows uncertainty.

Selected routes capture an authentic epoch snapshot from the same shared native Bridge owner under the target lock, before initial turn verification. That original snapshot is never refreshed. Mapped routes do not read selection. After a confirmed write, the original target, active turn, completion evidence and resident generation are rechecked. A dedicated checked Steer resident entry point then carries synchronous Selected-epoch, original active-turn and generation validation through the existing scoped mutation path, including actual native writer validation after asynchronous preparation. Same-owner Use changes, including away/back, cannot pass a stale selection to the wire. A later turn or resident replacement likewise cannot refresh authority. The final RPC retains the original expected turn and generation, durable mutation fence and target lock. This snapshot guard is not a Bridge selection lease and requires the existing single-owner/no-mixed-writers contract; it does not detect external or legacy selection writers.

## Fixed adapter profile

These are implementation safety limits, not throughput or Rust-relative latency criteria:

- One active native origin writer per installed owner; one process-wide Control slot; no waiting queue
- 16 KiB UTF-8 per ingress key, thread or turn; 64 KiB UTF-8 prompt
- 32 KiB pinned database path
- 512 KiB serialized request envelope and 256 KiB acknowledgement, both checked before submission
- Exact bigint actor/event identities in the nonnegative signed-i64 store range; exact unsigned-u64 resident generation
- Default 6,000 ms caller deadline; supported range 1–10,000 ms; 100 ms SQLite busy timeout

Request/result caps bound copied protocol data, not SQLite query planning, catalog scanning, trigger work, native heap, filesystem delay or total execution time. A blocked worker can outlive the caller deadline while retaining its slot and target lock. Path pinning preserves native spelling and traversal; it is not secure inode identity.

## Verification

Pinned Node 24.21.0, bundled SQLite 3.53.4, emitted JavaScript profile RVSPNB, NODE_OPTIONS=--no-strip-types: **306/306 passed across 24 affected files**, zero failures/cancellations/skips. Revised strict typecheck, production build and changed-file whitespace checks passed. All ten frozen source/test hashes match the tested candidate.

Independent final frozen-source review found no remaining confirmed P1/P2 findings and closed the Selected race. The reviewer independently ran all three new compiled suites on Node 24.21.0: 38/38 passed (16 integration, 17 native boundary, 5 store), zero failures/cancellations/skips. All ten source/test hashes matched before and after review. These 38 tests are a subset of the affected total, not additional tests. Initial tests and review exposed one confirmed source issue and three fixture issues. Independent review reproduced a same-owner Selected change after the final completion read; the checked resident dispatch guard above fixes that race, with away/back and delayed-native-preparation regressions. The first eight-case integration run had a new test expecting `confirmed` instead of the existing journal state `completed`. The first 20-file affected run passed 221/222; its new generation-replacement fixture tried to restart an active turn and was corrected to emit completion first. A later late-turn fixture attempted a second RPC while native preflight owned the writer and stalled; those test runs were stopped and preserved, then that fixture was changed to an unsolicited notification through a temporary file. Neither fixture correction is a runtime fix. Counts from separate runs are not additive.

Local evidence: .runtime/steer-origin-final-sha256.txt; .runtime/steer-origin-build-final-revised.json; .runtime/steer-origin-affected-tests.txt; .runtime/steer-origin-affected-final.tap; .runtime/steer-origin-typecheck-final.log; .runtime/steer-origin-production-build-final.log. Generated output and test logs remain local.

## Remaining limits

The unresolved-origin barrier is runtime-local fail-closed ownership, not a cross-restart reconciliation mechanism. Original gateway custody prevents duplicate replay in the tested pipeline, but this slice does not add a new durable origin-to-ingress reconciliation ledger. Direct compatibility PromptControlActions construction retains the old synchronous helper. Busy-choice component Steer still calls state.recordUserOrigin in component-worker/busy-control.ts; Repair's synchronous claim/guard boundary is also separate deferred work. Other synchronous work elsewhere in the runtime remains.

Windows behavior, complete live integration, process-crash/long-duration/load qualification, comparative performance and deployment remain unqualified. No live database, credentials or raw operational logs were accessed. The protected redaction test was not directly inspected, modified or selected for execution. Implementation performed no Git operation, publication, deployment or live restart. Publication and any subsequent migration slice remain separately authorized and verified work.
