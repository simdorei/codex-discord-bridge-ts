# Server-request cancellation forwarding — checkpoint 969 WIP

## Scoped result

Two existing captured transport adapters now forward the original optional `AbortSignal` to `sendValidated` while retaining the original receiver through `Reflect.apply`:

- `ServerRequestDelivery` forwards to its captured `DiscordReceiptTransport`.
- `startServerRequestRuntimeWorker` forwards to its captured HTTP adapter.

The original receiver, delivery owner, receipt identity, retry classification and native confirmation owners are unchanged. This is a cooperative cancellation propagation fix. It introduces no new consumer, persistent transport, response capability, database operation or runtime activation.

This supersedes checkpoint 896's historical statement that the automatic transport discards its optional signal. The current adapters forward it; the earlier checkpoint remains a record of the implementation qualified at that time.

Cancellation is not permission to abandon admitted work. The existing delivery/worker path still retains ownership until the invoked callback settles. A valid late message ID still requires durable native confirmation before release; cancellation without a validated ID leaves the already-started receipt unknown and blocks resending it. The fix does not establish that a passive callback's ID represents genuine remote acceptance.

## Recovered qualification evidence

This checkpoint documents saved final author and independent validation receipts recovered after an environment transition. Recovery did not rerun tests or compilation. Both saved runs qualify the same final six source/test files; their frozen input/source hash maps and emitted JavaScript are identical. The complete qualification manifests differ in run-specific execution paths. Read-only recovery checked all 921 current inputs, 922 physical frozen copies per run, both emission trees and the pinned Node executable against the saved hashes. Private home/temp directories were still empty.

The original runs used pinned Node 24.21.0 and TypeScript 7.0.2, fresh frozen input/output roots and the existing 300-second owned-process supervisor. The compiler specifications explicitly enabled strict checking, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, and `skipLibCheck=false`.

- Selected graph: 668 project modules and 178 declarations.
- Production graph: 656 project modules and 178 declarations.
- All 656 production JavaScript emissions match byte-for-byte between selected and production compilations, and between the author and independent runs.
- Executed tests: 6 new cancellation cases, 17 existing delivery cases and 10 existing worker cases; each saved run reports 33 passed, with zero failures, cancellations, skips or todos.

Three modified HTTP-containing suites were strictly compiled but were not executed:

- `test/runtime/native-server-prompt-receipts.test.ts`
- `test/runtime/discord-runtime/server-request-start.test.ts`
- `test/runtime/discord-runtime/native-server-prompt-wiring.test.ts`

The changed `ServerRequestDelivery` adapter is exercised by the socket-free cases. The changed startup HTTP adapter is statically reviewed and compiled only. These results do not establish installed-startup or actual HTTP cancellation behavior.

## Genuine owners and passive transport

The six new cases use a real resident child and original subscription/worker where applicable, real SQLite receipts and real native receipt/read workers. Their `sendValidated` callbacks are passive branch witnesses. No new test opens HTTP transport or establishes remote acceptance.

The cases cover:

1. Exact signal and receiver forwarding during direct delivery.
2. Exact signal and receiver forwarding during recovery.
3. Exact pre-abort reason, with no receipt or callback entry.
4. Post-intent abort propagation, callback join, retained unknown receipt and no resend through a recreated delivery.
5. Original worker/receiver retention until callback settlement; release afterward without a second send.
6. A passive valid ID returned after cancellation, followed by a genuinely locked native confirmation; the receiver remains owned while the native operation is blocked and closes after successful confirmation.

The last case checks event-loop progress and actual native-lane ownership while a SQLite write lock is held. It is not a network-delay or remote-acceptance experiment. Fixture cleanup and native-lane assertions are application-level test evidence; supervisor process disposal is a separate observation.

## Process evidence and identities

Every selected-compile, production-compile and test receipt in both runs records natural exit code 0, streams EOF, no remaining owned processes or live pidfds, and a no-children wait result. There are no forced signals, supervisor errors or shutdown reasons. The supervisor explicitly leaves application cleanup unqualified; its claim is confined to the processes it owned.

The author test direct process exited after 15.034820 seconds, with supervisor total 15.065895 seconds. The independent test direct process exited after 14.080258 seconds, with supervisor total 14.111353 seconds. Each test receipt recorded 34 owned process identities. Saved PID/start-time/namespace observations bind those receipts to their original runs; current process-list absence was not used to infer old-process closure.

Author-final evidence root basename: `server-request-cancellation-969-author-final-20261017-WtGiOxrV`.

- Qualification manifest SHA-256: `254dd60081883a2741e136a9a3732c2da55e97a8124baeed9fd3146f5c1db8c1`.
- Test process receipt SHA-256: `26719ba2d13a171f74c9544bb5ee75bad3c047193eb26e217f56445bf4eec792`.
- Post-test audit SHA-256: `bbaabe1e3ba18fbfbb7fa06a58eacb128662d86e906e1653160ec4df7a46a8a6`.

Independent evidence root basename: `server-request-cancellation-969-review-20261017-gDYQnpxR`.

- Qualification manifest SHA-256: `334eca0a0c81d3780e86a2994e5feb80bd34cd9fb655de3419bbdb446b4f92b3`.
- Test process receipt SHA-256: `9b7e02328fde4f237e53a5e5d8b32044a32e29fdd37889c104c1f8fb9c8149df`.
- Post-test audit SHA-256: `60159f7ec28dba086a4918e82dae7c0c73b665147e49704a686953de2a43eca4`.

Shared source graph SHA-256: `8a2c98dbea6d66f524618c296a4f3415c52bfbd6d724c16558caeb70e05011e7`.
Shared production emission map SHA-256: `4f868c1b27695959fa2f2406d161871c25f13ed7e4089a05d6c7dea3fe8e34d0`.
Shared selected emission map SHA-256: `e85074b1c7d570a1f5615923291d02a4282047169acc3d5bcd931045a85f31aa`.

The companion [public evidence manifest](server-request-cancellation-969-manifest.json) records the exact six file hashes and receipt identifiers without publishing raw logs, database artifacts, secrets or private absolute paths.

## Unqualified behavior and next gate

This is a bounded TS ownership regression checkpoint, not complete Rust cancellation parity. The immutable Rust shutdown reference remains documented in [checkpoint 968](native-prompt-read-store-diagnostics-20261017.md). Tokio future-drop behavior is not equivalent to TS cooperative cancellation and actual-exit joins; no new cross-language execution comparison was performed here. Signal forwarding does not preempt an uncooperative callback or establish a hard completion deadline. Existing Rust-domain and full original receiver/caller parity requirements remain open.

The saved supervisor offers bounded ownership tracking and private resources, not filesystem/network/cgroup/namespace isolation. Historical V4 descendants remain unknown and untouched. No genuine HTTP execution, authentic operational root, persistent activation, physical-store/external-writer exclusion, live app-server/CUA installation, full local-application/guard semantic compilation, performance/soak or deployment is qualified. This is not an overall A–G PASS or migration completion.

The next qualification boundary is the original installed HTTP/startup path and complete receiver/caller ownership under the existing root, socket and containment restrictions. The recovered evidence does not authorize bypassing those gates.
