# Checkpoint 883: native Repair admission reads

2026-10-15 UTC. RuntimeCommandExecutor now supplies its existing native intake state's passive admission reads to AdmittedRepairExecutor. Repair captures the read port at installation and passes it through the existing claimAdmittedRecovery entry point into loadLifecycleAdmission. Its original message admission read therefore runs in the existing bounded native intake worker before the existing synchronous one-use claim and target-lock acquisition.

This is a bounded read-wiring migration slice, not a whole-runtime, performance, Windows or deployment PASS. Baseline: cb325073fae5c47183f493b1fd5eba4b1e291041 (checkpoint 882). Source changes are confined to action-executor/{command-executor,recovery-custody,repair-action}.ts. Two existing test files add and extend regressions. All four unaffected checkpoint-882 frozen source/test hashes match.

## Preserved authority and custody

The captured AdmissionReads port is the existing passive, path-bound implementation. It captures own function values, rejects accessors, proxies and generators without invoking their hooks, requires genuine Promise results and preserves original errors. Replacing input properties later cannot replace the installed functions. There is no new worker, protocol, schema, SQL, admission, fallback or repair authority.

The existing lifecycle validator captures the actor before its first await, retains exact bigint event and actor identities, and checks the original stored actor/channel/event/source event, command, state, phase, owner, target and frozen binding. A read result remains an observation. The existing one-use claim still rejects a stored record that changes after the native observation; it does not substitute a replacement read or refresh the original request.

Repair carries the original stored Stop origin into the same existing dispatch scope. The stale-origin regression preserves the existing ordering: read-only thread status and MCP inventory may run, but reset/initialize/probe dispatch is refused. A mutation-fence refusal is not RecoveryGuard's owned rejected-before-send proof. The existing conservative target lease, recovery_claimed journal phase and outcome_unknown diagnostic receipt remain held. This slice does not reclassify that refusal or relax unknown-outcome custody.

RecoveryGuard's synchronous claim/check and actual RPC mutation checks remain unchanged, as do Selected snapshot/epoch validation and the shared native Bridge owner's no-mixed-writers contract. NativeRecoveryOwner, its worker and the recovery store custody implementation are unchanged. Existing direct construction retains compatibility defaults; only the installed RuntimeCommandExecutor path supplies the native admission port here.

## Bounded cancellation and admission

The installed admission read uses the existing Control lane and finite worker budget, with no waiting pool or synchronous fallback. It does not receive a new AbortSignal API. Existing pre-read and post-join cancellation checks still wait for real native exit before settling, and no later claim, lock acquisition or RPC begins after cancellation of that admission read. Saturated Control admission fails before claim/target acquisition while preserving an unrelated owner of the same target lock.

Repair's existing native queue/intake preflight order is unchanged after admission and claim. A cancellation while its final native intake preflight is blocked retains the original target lock and Control slot until that read exits, then sends no successor RPC. No worker termination or detached SQLite race was introduced.

## Verification

Pinned Node 24.21.0, V8 13.6.233.17-node.53, bundled SQLite 3.53.4, emitted JavaScript profile UJdzdp, NODE_OPTIONS=--no-strip-types: **510/510 passed across 43 affected files**, zero failures/cancellations/skips, exit 0. The focused four-file run passed **110/110**, also with zero failures/cancellations/skips, exit 0. Focused cases are a subset of the affected total, not additional tests. Strict TypeScript, production build, emitted-profile build and changed-file whitespace checks passed. All five frozen source/test hashes match after the affected run.

Coverage includes the actual RuntimeCommandExecutor path with poisoned synchronous getIngress; observed native admission before queue and intake reads; unavailable native admission without fallback, absence substitution or effect; Control saturation; blocked admission and final-intake cancellation with joined native exit and lock ownership; passive captured functions and mutated actor input; hostile ports and non-Promise results; exact read-error identity; actor/channel/event/source-event/command/state/phase/owner/target/binding mismatches; exact IDs above JavaScript's safe Number range; record changes between observation and the unchanged one-use claim; and stale original Stop revision with no repair mutation. Affected suites retain existing repair, recovery custody, lifecycle, selected guards, runtime composition, worker budget/slot and store regression coverage.

The interrupted initial focused run completed 109/110 with one fixture failure: the new stale-origin test incorrectly required zero read-only RPCs. The first reconciliation run completed 101/102 and exposed its second incorrect assumption that the target lease would be released. The final fixture asserts the unchanged read-only preflight plus conservative lease/unknown-outcome behavior. Neither correction changed production behavior. These are separate runs; their counts are not additive.

Independent final source and boundary review found no confirmed blocking findings, verified the final frozen hashes before and after review, checked the 110/110 focused evidence and confirmed that the checkpoint scope/limits and stale-origin assertions preserve existing custody. The reviewer did not substitute that review for the affected regression run.

Local evidence: .runtime/repair-admission-final-sha256.txt; .runtime/repair-admission-build-final.json; .runtime/repair-admission-focused-final.tap and .exit; .runtime/repair-admission-affected-tests.txt; .runtime/repair-admission-affected-final.tap and .exit; .runtime/repair-admission-typecheck-final.log; .runtime/repair-admission-production-build-final.log. Initial and reconciliation failures remain preserved in their original and .runtime/repair-admission-reconciliation-* evidence. Generated output and test logs remain local.

## Limits

The synchronous Repair claim/guard boundary remains deferred. This checkpoint does not complete the migration or qualify Windows, live whole-runtime behavior, process-crash/long-duration/load operation, Rust-relative performance or deployment. The protected redaction test remains unavailable; it was not inspected, modified or selected for execution and is not counted as a pass or skip. No live database, credentials, raw operational logs, Git write, publication, deployment or live restart was used. Publication and subsequent migration slices remain separately authorized and verified work.
