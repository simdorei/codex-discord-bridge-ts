# Native dead-generation persistence

Checkpoint 909 moves the installed resident's dead-generation capture transaction into one native Control worker. It does not qualify the exclusive-writer profile or complete startup/restart database isolation. Final synchronous wire validation, custody and preflight guards remain unchanged. The original synchronous persistence adapter remains available for compatibility.

## Ownership and ordering

`startRuntimeResident` installs a separate `ResidentNativeDeadGeneration` capability. No Promise is passed into `pinPersistence` or its synchronous `persistDeadWork` hook. The existing `TargetLocks('restart')` ownership spans capture, native completion, post-await validation, exact in-memory settlement and replacement. Terminal close and other restarts remain serialized behind that same lock.

The fence first requires the exact current generation's actual owned-child exit, final transport closure and zero admissions with admission sealing. Closure alone, missing process information and request history cannot establish native exit. The existing live-quarantine and intentional-quiescent-cleanup branches are preserved. Empty dead work is still captured.

The original client, generation and immutable work remain retained across the await. Before settlement the fence rechecks current client identity, generation, pending restart, nonterminal state, sealed admissions, native exit, transport closure and full observed work equality. Request ID types and signed integer values, all occurrence bytes, parameters, vector ordering, active turns and closure reason are preserved. No history is cleared, client removed, generation advanced or replacement started before confirmed capture.

## Closed native operation

`NativeDeadGenerationOwner` submits one closed existing-only operation through the existing `OwnedWorkerSlot('Control')`, with no waiting queue or new worker pool. The worker reconstructs branded request occurrences from explicit 16-byte vectors, derives the original affected-target set, produces the existing source-format serialized snapshot and calls only `StateAccessFacade.captureDeadGenerationExisting`.

The unchanged transaction checks the runtime, decodes all queue rows before filtering, captures exact queue work, creates holds and stages notices atomically. There is no schema initialization, activation, repair, arbitrary SQL/callback dispatch, request replay or independent incident-generation scheme.

A per-operation nonce and SHA-256 binding cover the entire original request: pinned path, runtime, resident instance, startup channel, generation and exact transferred work. The worker independently recomputes that binding. The parent accepts only one exact bounded acknowledgment for that invocation and waits for actual native exit. The binding is internal consistency evidence, not a transferable authority proof or database credential.

## Uncertainty and cleanup

Missing, duplicate, malformed or crossed acknowledgment, crash, cancellation and timeout do not settle in-memory work or authorize replacement. The accepted worker registration and Control slot remain owned until actual exit; no database worker is terminated to simulate a join. A commit may already exist after a lost acknowledgment. That attempt remains unsuccessful.

A later restart may confirm the same exact stored snapshot through the existing reconciliation branch. Its `false` result means confirmed preexisting capture and is successful only after the new exact acknowledgment and exit. It neither adds another incident nor duplicates holds/notices. A changed stored snapshot is refused. The original restart obligation remains intact after an unsuccessful attempt; supervisor retry policy is unchanged.

Resident startup failure and terminal cleanup join/close the native capability. Existing synchronous old-child-exit journaling, idle journal installation, startup activation and final wire guards remain outside this slice.

## Bounds and accounting

The selected work transfer limit is 1 MiB, with at most 65,536 entries per vector. Parent path, runtime and resident identifiers are separately bounded; worker request validation permits at most 1,114,112 serialized bytes. Acknowledgments are bounded to 32 KiB and worker diagnostics to 2,048 Unicode code points. Oversize evidence is refused rather than truncated. Source snapshot serialization and target derivation run in the worker; immutable client snapshots and a bounded transfer digest still run on the main thread. These are transfer bounds, not SQLite scan, allocation, RSS, throughput or event-loop latency guarantees.

The closed worker inventory is 83 modules, 49 potential writers. The new worker is classified against its original `path`; existing registration, single-Control/eight-total budget and actual-exit accounting are unchanged. Stage 893 remains inactive.

## Verification scope

Validation uses pinned Node 24.21.0 / TypeScript 7.0.2, the private compiler profile excluding exactly `test/remote-agent/redaction.test.ts`, emitted JavaScript and `NODE_OPTIONS=--no-strip-types`. The protected file is not read, compiled, run or reconstructed. The known Unix root-store-authority EPERM case is outside the selected tests and is not retried. No live database, secrets, external communications, Git writes, uploads or deployment are involved.

Coverage includes async eligibility and empty work; full snapshot, terminal and client/generation mismatch across await; installed native capture while the main-thread capture helper is poisoned; real committed-before-ACK-loss/duplicate/corruption/crash cases; delayed native exit; cancellation/timeout and Control registration retention; exact reconciliation without duplicate notices; changed-snapshot refusal; corrupt unrelated queue rows; existing-only schema/runtime failures; bounded transport; and concurrent restart/close. Compatibility and final-guard regressions are selected separately.

This is bounded offline verification, not a full-suite, complete migration, production, Windows, load/crash endurance or 24-hour qualification.

### Checkpoint 909 verification results

Baseline: `61bf6606f7ca453463f7560a485bc9062da59aac`. Final writer profile: `.runtime/compiled-tests-5xjHDR`.

- Strict source/test typecheck with the exact protected-test exclusion and production build passed. This is not an all-test typecheck claim.
- All 951 emitted production modules match `dist/src` byte-for-byte. Sorted SHA-256/path graph digest: `9eb363b9043a3bb92d1fc20ff752d3342d1c0403a17d1b7bc02c38e2295794ae`.
- Final focused run: 36/36 across three files. Final bounded affected run: 176/176 across 17 additional files. Both have zero failures, cancellations or skips. Exact selections and logs are retained under `.runtime/dead-generation-909/` in `focused-tests.txt`, `affected-tests.txt`, `focused-frozen.tap` and `affected-final.tap`.
- Initial failed native-accounting fixture setup and the initially stale 82-module audit assertion were corrected. Their logs remain retained and are not represented as successful runs.
- Independent review passed 139/139 focused/regression/audit tests and 15/15 separate adversarial probes, all with zero failures, cancellations or skips, on `.runtime/compiled-tests-awXLxg`. It independently verified all 951 production module hashes and no source/test drift across its 1,914 protected-excluded inputs. Those overlapping checks are not an additional unique full-suite total.
- The exact changed-file freeze and validation metadata are retained in `.runtime/dead-generation-909/final-freeze.json`; production parity is in `production-parity.json`. No runtime/deployment authorization is implied.
