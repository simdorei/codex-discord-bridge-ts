# Persistent receiver pre-admission probe — checkpoint 974

Status: diagnostic counterexample established with explicit probe-only teardown instrumentation and endpoint rescue. **No implementation fix or cleanup/component/root qualification.**

## Exact counterexample

The real disposable persistent resident starts its original child and SQLite lifecycle. Its original receiver client posts the first `all-jobs` request. The fixed owner fault closes control immediately before admission; the unchanged quarantine filter discards the validated submit. Independent main/worker observations establish dropped ID 1 and the original pending client ID 1. No receiver service operation was admitted or completed, no business response or HTTP receipt was written, and no transport call occurred.

This directly diagnoses the receiver endpoint, not the full server-request loop. The existing client, wire protocol, native service implementations, and business processing are unchanged.

## Two explicit diagnostic interventions

1. Only the selected probe with the exact original pending-slot proof uses the existing lifecycle-failure teardown path. This keeps original native-service close usable until original disposal settles; the unchanged finally block then quarantines those services. Ordinary receiver faults still use protocol-failure teardown.
2. Only after the original accepted component-failed report confirms child disposal, and after both exact-ID observations plus unchanged zero-admission state are checked, the probe closes this construction's remaining data endpoint. It does not settle a client operation, synthesize a business result, retire an ID, retry, or release root debt.

At actual requester exit, the original client still retained ID 1 with no terminal or control join. Both physical endpoints closed, but the component remained quarantined, unreleasable and logically unqualified. The test root remains retained.

The optional one-shot 1,000 ms snapshot is non-terminal diagnostic output only. It never races, replaces, cancels or settles the original join. Final assertions and the exact canonical witness occur only after actual original component join.

## Reviewed execution

The final fresh run strictly compiled 343 selected TypeScript sources and 341 production sources, with 178 declarations per build and all 341 production emissions identical between builds. Its exact guarded graph has SHA-256 `4adcadb7cb0f88943e5dc3f9b90a0a80900cc19f3a7fa7e1d585467face607c3`.

Runtime result: **2 tests, 1 invariant pass, 1 mandatory logical-cleanup failure**, zero cancelled/skipped/todo, Node exit 1. The supervisor observed natural owned-process exit after the explicitly labeled rescue, ECHILD and output EOF, with no signals/errors or remaining owned processes. This is rescue-assisted physical closure, not normal component cleanup. One probe root remains; no root was deleted. Exact hashes and runtime duration are in the public manifest.

Independent source and graph/argv review preceded each attempt. The final verifier requires the exact ordered test names/outcomes, one bounded ASCII canonical witness on stdout with the teardown/rescue labels, immutable frozen inputs/emissions, empty private HOME, and exactly one retained probe root. Execution used the unchanged owned-process supervisor with a 300-second deadline, seven-second containment cleanup and eight-MiB output limit.

## Preserved failed first attempt

The first attempt also compiled strictly, but the invariant timed out after 20 seconds and no final counterexample witness appeared. The original protocol-failure path quarantined native services before disposal; their close calls could reject, leaving child closure unconfirmed and the correctly strict rescue gate closed. This attribution is source-reviewed; the first attempt did not emit the required state witness.

At the 300-second deadline, its supervisor sent SIGTERM to two surviving newly owned processes. The receipt records all owned processes exited, ECHILD, EOF and no containment errors. **This was forced containment, not natural cleanup.** The failed root and complete local evidence remain preserved. No old process was inspected or controlled. The corrective probe instrumentation did not relax the rescue gate or any join/release predicate.

## Next implementation and remaining limits

The independently reviewed next finite fix remains unimplemented: exact-ID sealed no-admission evidence; preserve the viable data route on generic quarantine; close only unusable channels without inventing logical join; preserve known terminals across control-loss orderings; distinguish first caller-origin abort from bridge-fault abort. The fixed regression must join without the probe rescue or probe-only teardown path.

Before-admission data loss, malformed/control-loss active native work, wrong/duplicate proof IDs, both terminal/control orderings, fault-first then caller cancellation, and lost-proof/both-channel loss still need their specific reviewed regressions. Full-loop ACK loss remains separate from the earlier direct-delivery case. No earlier qualified positive suites were rerun here. The prior checkpoint's 102/100/2 result is historical evidence for its own bytes, not this candidate.

There is no installed persistent cutover, live HTTP, live CUA/browser, singleton/root acquisition or root-exclusion test, performance/endurance qualification, or overall Rust-migration PASS. Original Rust remains pinned to `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`; this diagnostic changes no business semantics. Genuine POSIX root qualification remains required before installed wiring. Historical v4 process status remains UNKNOWN and untouched; absence from a current process list is not closure evidence.

The public archive contains only six source/test files and this scope/manifest pair. Databases, raw logs, credentials and private execution directories are excluded.
