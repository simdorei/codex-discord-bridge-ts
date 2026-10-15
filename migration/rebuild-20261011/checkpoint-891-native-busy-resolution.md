# Checkpoint 891: native Busy control resolution

2026-10-15 UTC. The installed Busy Stop/Steer handler now resolves its original control binding through the executor-shared native Busy claim owner. Migration and whole-runtime qualification remain incomplete.

Baseline: 7c0d80d5a0e6f53f2bc3ae95957ac74b32fd4414 (checkpoint 890). Six production files and two test files are frozen in .runtime/busy-resolution-final-sha256.txt. No schema, facade alias, claim key, ready marker, ingress payload, response authority or receipt-domain changes are introduced.

## Resolution and capability ownership

NativeBusyClaimOwner now owns Resolve alongside the checkpoint-890 Claim/Ready/Release operations. Only its private WeakMap-backed, original non-Queue claim handle can resolve. The caller supplies its original pre-ACK choice and action, which must exactly match the already captured claim identity. Copies, JSON records, cross-owner handles, changed actor/channel/target/prompt/choice/expiry/allowSteer, wrong action and consumed handles cannot grant resolution. Queue and Ignore cannot resolve.

Resolution has a distinct one-use phase. Confirmed resolution may still finish the original claim through Ready or Release, but cannot resolve again. Pending or unknown resolution permits neither Ready nor Release. Positive pre-submission cancellation, owner-busy or global-capacity refusal preserves the unused resolution capability. The installed path does not retry automatically: a definite refusal follows the existing release/preflight-rejected path; only a fresh authorized click can try later.

The shared unresolved-mutation barrier now includes Resolve. An admitted unknown, partial, crossed, malformed, oversized, cancelled or timed-out resolution ACK blocks fresh claims and any other already-held claim's resolution. A second claimed action waiting on the same target lease sees that barrier after lock transfer. Explicit same-original ready recovery remains read-only and cannot resolve or clear the barrier. This is runtime-local ownership, not cross-restart/crash reconciliation.

## Existing-only IMMEDIATE store mutation

resolveBusyControlExisting uses the original IMMEDIATE lookup and conditional pinning operation, with current-catalog verification inside that transaction. It never creates, initializes, migrates or repairs a database. The compatibility resolveBusyControl API keeps its original initialization and behavior through the shared SQL body.

The original explicit turn takes precedence, including an empty turn string. Without an explicit turn, only the exact preceding job ID and original thread qualify, and only while the job is running with goal_waiting=0. No current active turn or later job is discovered as a substitute. The existing preparing-binding trigger and first-turn pinning semantics are unchanged. When resolution pins a turn, exact same-transaction readback verifies the original choice/thread tuple, job ID and resolved turn before commit. Ignored updates, missing/deleted rows and trigger-induced job/thread/turn drift roll back and are conservatively reported unknown through the native owner. A later confirmed job turn cannot replace an existing pinned turn.

## Native transport and installed behavior

Resolve uses the existing zero-queue Control lane and bounded native request/reply envelope. It retains the operation UUID, pinned database path, original interaction/ingress/application identity, actor/channel/source message, exact raw custom ID, action, serialized pre-ACK choice, ready marker and operation timestamp binding. The worker decodes the original target from that captured choice. No caller-supplied JSON claim proof is trusted.

Every submitted resolution joins actual native exit before its promise settles. Timeout/cancellation never terminates a blocked database worker or releases Control capacity, the target lease, interaction admission or ingress custody early. A late pin commit is possible and remains unknown. Owner close aborts and joins its operations. Request/reply limits are transport limits, not SQL-row, native-memory or performance guarantees.

Installed Stop and Steer resolve under their existing shared target lease. A NativeBusyClaimUnknownError passes through the pre-dispatch boundary unchanged; the handler retains the Busy claim and records held ingress without a retry-enabling ControlNotDispatched/preflight receipt. No app-server RPC, Steer origin or success delivery follows unknown resolution. A confirmed null resolution or a later definite route/turn rejection still uses the existing release allowlist.

The exact pre-ACK prompt and target remain action authority. Existing actor/choice/Pro preflight, route checking, ended/superseded turn checks and presentation-only allowSteer=false behavior are unchanged. Queue keeps its separate atomic admission/ready transaction, and Ignore never acquires a target or resolves. Checkpoint-882 shared Steer-origin ownership, authentic Selected epoch capture, generation/original-turn actual-wire guard and synchronous final Repair behavior are unchanged.

## Verification

Initial emitted native/store run on 8oDHBk passed 100/100 tests with zero failures, cancellations or skips (39.371 seconds). Initial installed integration/compatibility run on iEhvHM passed 85/85 with zero failures, cancellations or skips (78.638 seconds). The final sgJ1Nc graph adds one oversized resolved-turn ACK case and two clarifying production comments to those initial graphs; no behavioral production changes followed the initial verification.

Independent read-only review found no P1/P2 findings. Its iEhvHM native-resolution and installed Busy integration suites passed 117/117 (100.572 seconds); sgJ1Nc compatibility suites passed 26/26, and the final oversized-turn test passed 1/1. All had zero failures, skips or cancellations. These overlapping review results are not added to the affected count. The reviewer verified all eight final hashes before and after, and confirmed the only final production differences from iEhvHM are comments.

Final strict no-emit, production build and whitespace checks pass under Node 24.21.0, NODE_OPTIONS=--no-strip-types and TypeScript 7.0.2. All eight frozen hashes match after emitted and production builds. The final focused emitted run passed 202/202 with zero failures, cancellations or skips (114.793 seconds). The final affected emitted run passed 1419/1419 across 131 explicit test files and 12 suites with zero failures, cancellations or skips (exit 0; 493.813 seconds). All eight frozen hashes match after the complete affected run. No full-suite or live-runtime pass is claimed.

Evidence prefix: .runtime/busy-resolution-. Files include files.txt; final-sha256.txt; build-initial/tests/final.json and logs; native-initial.tap and .exit; integration-initial.tap and .exit; focused-tests.txt; focused-final.tap and .exit; affected-tests.txt; affected-final.tap and .exit; typecheck-final.log and .exit; production-build-final.log and .exit; whitespace-final.log and .exit; hashes-after-build.log; hashes-after-affected.log; runtime-versions.json. Final emitted profile: .runtime/compiled-tests-sgJ1Nc.

No live database, credentials, raw operational logs, Git write, publication, deployment or restart was used. The protected redaction fixture was not inspected, reconstructed, modified, uploaded or selected for execution, and is not counted as a pass or skip. Windows, cross-restart reconciliation, performance qualification and whole-runtime readiness remain unqualified.
