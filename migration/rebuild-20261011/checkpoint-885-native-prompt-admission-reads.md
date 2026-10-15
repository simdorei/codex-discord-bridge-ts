# Checkpoint 885: native prompt admission reads

2026-10-15 UTC. RuntimeCommandExecutor now supplies its existing native prompt-intake state to QueuePromptExecutor's original-event read and ActionTargetServices' fresh mirror read. This is a bounded read-wiring slice. Migration and live-runtime qualification remain incomplete.

Baseline: 75f9b88955155693e54a30d46e4fb47c5fe6706e (checkpoint 884). Production changes are confined to action-executor/{queue-prompt,action-target,command-executor}.ts. No worker, worker protocol, pool, schema, store SQL or mutation operation changes are included. Completed-fork lookup still uses the unchanged original facade member retained by the native intake state; completed-target canonicalization is unchanged.

## Read capture and original ordering

QueuePromptExecutor captures the existing passive AdmissionReads port once at construction. Direct callers retain its compatibility default. The actual factory passes the already-created native intake state. Selection still precedes the original slash route check, saved replay, completed-fork canonicalization, optional busy choice and durable intake. A null event skips the original-event read and replay. Bigint actor, channel and event identities remain exact; signed/unsigned range boundaries are unchanged.

ActionTargetServices captures only its injected mirroredThreadId function as passive own data. Proxies, accessors, inherited methods and generator functions are rejected without invocation. Each call uses the original installation path and requires a genuine Promise; thenables are not assimilated. Mapping failures retain their error identity at this service boundary, and non-null mapping results must be valid text. Each currentMirrorTarget call performs a fresh read. Only a successful null result uses the original selected fallback; failure is never treated as absence. Existing durable-intake mapping loss or drift still refuses preparation and preserves the original request for recovery.

Both installed reads use the existing finite Control lane with no additional queue. Native intake reads do not accept an external AbortSignal. Existing caller cancellation checks remain before the relevant work and after joined reads. Cancellation holds the native slot until actual worker exit, then prevents successor work. There is no detached read, synchronous fallback, immediate SQLite interruption claim or read retry. Cancellation during the fresh mirror check retains the original durable intake claim for existing recovery.

Repair's preclaim and final borrowed-transaction/actual-wire guards remain synchronous and byte-unchanged. No cached asynchronous boolean replaces those guards. This checkpoint does not qualify a future Repair dispatch-custody migration.

## Verification

The final frozen affected profile QMTAXJ passed **770/770 tests across 70 files**, with zero failures, cancellations or skips, exit 0. All six frozen source/test hashes match after the run. Pinned runtime: Node 24.21.0, V8 13.6.233.17-node.53 and bundled SQLite 3.53.4.

Pinned Node 24.21.0, emitted JavaScript with NODE_OPTIONS=--no-strip-types. The initial focused profile gW0Hdj passed 92/92 tests across queue-prompt, action-target and command-executor, with zero failures, cancellations or skips. No source/test changes occurred after that build. Final frozen profile QMTAXJ contains those same six source/test files. Strict TypeScript and production builds passed. Initial typecheck exposed a Promise<unknown> return annotation and an intentionally malformed test-result cast; both were corrected before any test execution, and the failed typecheck log is retained.

Independent source and boundary review found no confirmed P1/P2 findings and verified all six frozen hashes and the diff. Its initial unit/native checks passed 33/33 and installed-prompt checks passed 12/12. Its final frozen-profile focused checks passed 22/22. These overlapping focused checks are not additional tests to add to the affected total.

Coverage includes passive constructor ports, replacement capture, genuine-Promise/non-assimilation validation, malformed mapping results, exact errors without successors, original path and >2^53 identities, null-event skip and replay ordering; installed Ask and Interview on both selected and mirrored routes with synchronous methods poisoned; native IngressOrigin and second MirrorTarget ordering; original slash refusal before existing saved replay; unavailable origin and mapping acknowledgements; changed/absent mirror refusal; responsive timers while cancellation joins real SQLite reads at both boundaries; and Control saturation before the original-event read. The affected list also retains existing native intake, worker capacity, action target, prompt, lifecycle, Repair and recovery-custody suites.

Local evidence: .runtime/prompt-admission-final-sha256.txt; .runtime/prompt-admission-build-final.json; .runtime/prompt-admission-focused-initial.tap and .exit; .runtime/prompt-admission-affected-tests.txt; .runtime/prompt-admission-affected-final.tap and .exit; .runtime/prompt-admission-hashes-after-build.log and -after-affected.log; .runtime/prompt-admission-typecheck-final.log and .exit; .runtime/prompt-admission-production-build-final.log and .exit; .runtime/prompt-admission-whitespace-final.log and .exit. Generated output and test logs remain local.

## Limits

Compatibility defaults and other facade operations remain synchronous where not separately migrated. This is not a whole-runtime, Windows, deployment, live restart, performance, load, crash or long-duration qualification. The protected redaction test was not inspected, modified or selected for execution and is not counted as a pass or skip. No live database, credentials, raw operational logs, Git write, publication, deployment or live restart was used. Publication, if authorized separately, requires verification against the exact remote commit and tree.
