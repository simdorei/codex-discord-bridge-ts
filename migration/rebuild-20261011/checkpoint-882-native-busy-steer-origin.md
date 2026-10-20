# Checkpoint 882: bounded native busy-choice Steer origin

2026-10-15 UTC. RuntimeCommandExecutor now installs the same NativeSteerOriginWriter in its ordinary PromptControlActions and busy-choice component paths. Repeated interactionServices construction retains that exact writer, shared native Bridge owner, ActionThreadSelection and target-lock registry. No per-click writer or replacement origin admission is created.

This is a bounded migration slice, not a whole-runtime, performance, Windows or deployment PASS. Source changes are confined to action-executor/command-executor.ts and component-worker/{ordinary-handler,busy,busy-control}.ts, with one new integration suite. The existing native origin writer, worker, snapshot contract, origin store primitive, checked resident dispatch method and ordinary Steer implementation are unchanged. All nine unaffected checkpoint881 frozen source/test hashes match.

## Identity and ownership

The installed component handler snapshots the original interaction envelope before its first await. Busy Steer separately captures the click's custodyIngressId, interactionId, userId and channelId before its first store/target await. It carries these exact values into the native origin request, including bigint IDs above the safe JavaScript Number range. sourceMessageId, choiceId and the prompt's earlier message never substitute for the click event or ingress key. These values correlate with the existing admission; they do not authorize a new admission.

The original pre-ACK BusyChoice snapshot and existing busy claim remain the action authority. The shared target lock is retained across original-turn binding resolution, selection and control checks, native origin execution and real worker exit, revalidation and checked dispatch. resolveBusyControl is deliberately unchanged: its existing IMMEDIATE transaction can pin the first observed turn from the exact preceding job and must not be treated as a read-only operation.

An origin whose acknowledgement is lost, malformed or unavailable after submission remains Unknown, including possible commit or rollback. NativeSteerOriginUnknownError bypasses the ControlNotDispatched wrapper. Existing busy error handling therefore retains the claim, and the interaction worker retains the original ingress without an action-success result, confirmation-ready marker or retry-enabling busy_control_preflight_rejected receipt. The same writer's unresolved-original barrier blocks later ordinary and busy Steer attempts, including another choice and a click already waiting for the target lock. A definite pre-submission refusal still permits existing claim release and a fresh admitted second click; it never substitutes for an uncertain submission.

The writer keeps checkpoint881's fixed database, Control1 lane, zero waiting queue, request/acknowledgement bounds, native-exit join and SQLite behavior. No synchronous fallback, worker termination, pool, schema migration, new ledger or automatic replay was added.

## Exact target and checked dispatch

Under the target lock, the installed Steer uses ActionThreadSelection.target to require the original busy-choice target and identify its route. Mapped routes acquire no Selected snapshot. Selected routes capture an authentic epoch token from the shared Bridge owner before initial ControlTurnVerifier verification, validate it against the original target and never refresh it.

Before recording origin, a synchronous guard checks that original Selected epoch when applicable, active turn, healthy lifecycle and resident generation. After confirmed native exit, ControlTurnVerifier rechecks the original route, expected turn and observed-completion evidence; the original generation is compared again. executeSteerControl carries the same synchronous guard through asynchronous mutation preparation to the actual wire writer. Same-owner Selected changes, including away/back, later turns and resident replacement cannot obtain fresh authority for the old click. Final RPC parameters retain the original target, expected turn and generation.

This is the existing single-owner/no-mixed-writers epoch contract, not a new Bridge selection lease or detector for external/legacy Bridge writers.

## Preserved behavior and limits

Queue still uses its existing atomic intake/receipt branch. Stop, Ignore, Pro rejection, claim classification, ready-marker recovery, lazy confirmation delivery and clearing are preserved. Stored allowSteer=false continues its existing behavior; the migration does not invent a new rejection based on that field. Direct compatibility component construction without the installed native services retains the previous synchronous origin helper.

Canonical non-Queue busy repeats retain the existing manual-review-only behavior, including after a successful Steer. Only prompt-owned Queue canonical repeats are admitted to the interaction worker's ConfirmationOnly mode. The existing confirmation-only handler and prepared-delivery retries still perform notification/clear only, without origin or control replay; this slice does not expand canonical confirmation admission.

The unresolved-origin barrier is runtime-local fail-closed ownership, not durable cross-restart reconciliation. Interaction business services have no newly added cancellation API. The cancellation integration test injects native slot cancellation while a real SQLite writer is blocked and verifies that the original target lock, executing ingress and admission permit remain held through native exit before the existing worker records its hold. It does not claim a new public component-cancellation contract.

Other synchronous component/store operations, including resolveBusyControl, and Repair's separate synchronous claim/guard boundary remain deferred. Windows, complete live integration, process-crash/long-duration/load qualification, Rust-relative performance and deployment remain unqualified.

## Verification

Pinned Node 24.21.0, bundled SQLite 3.53.4, emitted JavaScript profile rOMhCu, NODE_OPTIONS=--no-strip-types: **570/570 passed across 50 affected files**, zero failures/cancellations/skips. Strict typecheck, production build and changed-file whitespace checks passed. All five frozen changed source/test hashes match the tested candidate.

The new suite contributes 25 integration cases within that affected total. It covers actual RuntimeCommandExecutor.interactionServices; poisoned synchronous origin fallback; exact captured click identities and mutated input; stored allowSteer=false; commit/rollback lost acknowledgements; original held ingress and canonical duplicate/second-click admission via stageOrdinaryInteraction/admitBusyInteraction; ordinary-to-busy and busy-to-ordinary shared uncertainty; pre-submission refusal; native cancellation/lock/custody join; original binding/mapping refusal; later turn, mapping, completion and generation changes; Selected change and away/back at initial and final verification; delayed native preflight at actual wire; successful checked dispatch; confirmation and failed-clear retries; and unchanged Stop/Ignore behavior. Existing affected tests cover Queue, compatibility, claims, staging, resident guards, native bounds and the origin store.

Independent final review found no confirmed P1/P2 findings, verified all five frozen hashes, and independently reran all 25 new emitted integration cases: 25/25 passed. These are a subset of the affected total, not additional tests. The first 22-case integration run passed 14/22 and exposed fixture errors: attempts to mock a frozen Bridge method, incorrect expectations for absent outcome and the existing executing journal state, and an incorrect assumption that non-Queue canonical repeats could enter worker ConfirmationOnly. Those fixtures were corrected without a runtime source change; the next 22-case run passed before three further regressions were added. Separate run counts are not additive.

Local evidence: .runtime/busy-steer-final-sha256.txt; .runtime/busy-steer-build-final.json; .runtime/busy-steer-affected-tests.txt; .runtime/busy-steer-affected-final.tap; .runtime/busy-steer-typecheck-final.log; .runtime/busy-steer-production-build-final.log. Generated output and test logs remain local.

No live database, credentials or raw operational logs were accessed. The protected redaction test was not directly inspected, modified or selected for execution. Implementation performed no Git write, publication, deployment or live restart. Publication and subsequent migration slices remain separately authorized and verified work.
