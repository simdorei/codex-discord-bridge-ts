# Native automatic-form serial-loop integration

Date: 2026-10-17 UTC. Checkpoint 971. **Bounded installed-core regression qualification; no live Computer Use, HTTP, operational-root or overall migration PASS.**

## Missing coverage and exact change

Only `test/runtime/server-request-native-form-integration.test.ts` is added. No production source, policy, native owner, worker protocol, startup wiring or cleanup predicate changes.

Earlier form tests used `test/helpers/server-prompt-fixture.ts:13–14`: a real child and resident, but a null response fence and no native response-completion owner. The checkpoint 970 genuine `startRuntimeResident` fixture exercised non-form direct delivery/recovery, not automatic forms through the serial worker. This increment composes the existing installed core rather than adding another adapter or codec.

Each new fixture calls the original `startRuntimeResident`, activating genuine SQLite custody, native dead-generation/idle/observation owners, the actual app-server child and native response completion. It creates the original business receiver before request emission and initial recovery, then gives that exact receiver to `runServerRequestWorker`. A separate test-only observer captures the child's original request occurrence; it never responds or delivers. Native prompt observations and native receipt storage are enabled on the unchanged `ServerRequestDelivery`.

The test directly composes these production-used functions with disposable configuration. It does not call the HTTP-bound `startServerRequestRuntimeWorker`, acquire the POSIX singleton, construct the complete local application, start Discord, install a provider or exercise a connected computer/browser.

## Immutable Rust basis

Original repository: `simdorei/codex-discord-remote-rust`, commit `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`.

- [server_request_worker.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/server_request_worker.rs), blob `5173d828b261f9f0d0429b75a6dbb09d76410707`: one serial receiver/recovery/retry loop (47–111); original authority verification before automatic local response (151–176); non-form prompt identity/cache and per-chunk authority/receipt delivery (178–258).
- [server_request_worker/local_tools.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/server_request_worker/local_tools.rs), blob `6cf1300755b3f3cf44021129b677fa920944f989`: low-risk `node_repl` computer-use/browser empty-schema forms accept; other supported forms cancel; non-forms continue ordinary prompt processing. This application response does not grant arbitrary tool or persistent permissions.

Both immutable blobs were independently reviewed. This is a source-grounded TypeScript regression, not an executed Rust binary comparison or complete Rust error/timing parity claim.

## Six exact cases

1. A low-risk computer-use form already pending at initial recovery is accepted through the original resident response path.
2. A low-risk browser `openai/form` delivered as a live event is accepted.
3. An elevated-risk form is answered with the original cancel payload.
4. During initial recovery, cancellation after native response completion commits still waits for actual native exit. Recovery's existing cancellation boundary suppresses the downstream failure in favor of the original stop reason.
5. During live-event processing, the same cancellation/exit sequence reports the existing joined `MutationOutcomeUnknown` failure. The committed row remains flushed and grants no replay.
6. A non-form approval enters passive transport, receives shutdown while the callback is held, then returns a known fixture message ID. The original worker joins the callback and native receipt commit before releasing its receiver. A recreated delivery reuses that receipt without a second callback; the approval remains pending and unanswered.

The form cases compare actual child-observed full response envelopes, original occurrence-bound request keys, request hashes, response hashes, runtime/resident/generation and durable row identity. They require no HTTP callback or delivery receipt for automatic forms. The non-form case requires no automatic response or response-custody row. An initial recovery can consume an occurrence before its already-buffered event is visited; only the original stale-authority error is permitted there, without another child response.

The two completion-exit cases use the existing test-only constructor instrumentation. The unchanged native response-completion module executes against its original input, commits the row, posts its original ACK and closes its port before a bounded fixture barrier holds actual Worker exit. No result, authority or ACK is fabricated. After shutdown, the loop remains unsettled and Control credit stays occupied until the barrier is released. This is retained-work/join evidence, not a deadline, throughput or concurrent same-target progress claim.

## Preserved first result

The first exact-source author run compiled with strict 341 selected / 338 production modules and production-byte parity, then reported **4/5 passed, one failed**, natural exit 1. The failure was an incorrect test expectation of one reported diagnostic during initial recovery shutdown. The unchanged recovery catch checks the aborted signal before retaining the downstream native failure, and the serial worker suppresses that exact stop reason. The test therefore must expect no report on that path.

Independent review confirmed this source ordering. Only the expectation changed, and the live-event branch was added separately to check its distinct surfaced Unknown behavior. The original actual-exit, durable-row, child-payload and no-replay assertions remain. No product defect or production fix is inferred from the failed attempt.

All original frozen/current inputs and outputs remained unchanged after that failed run; its test runner exited naturally with code 1; all observed owned process identities had exited, with ECHILD and output EOF, no supervisor signals/errors/deadline, and empty private HOME/temp. Its manifest, process receipt and failed-attempt audit remain retained and are hashed in the public manifest.

## Qualification and containment

The exact sole test root is `test/runtime/server-request-native-form-integration.test.ts`; all six tests execute serially without name filters or skips. The guarded explicit closure rejects protected inputs before reads. No package test/build script, whole-source coverage traversal or broad test discovery runs.

Each final freeze uses pinned Node 24.21.0 and direct TypeScript 7.0.2, strict NodeNext/ES2023 with configuration bypass. The selected and separate production builds each include 178 allowed declaration files; their project counts are 341 and 338. All 338 emitted production files match between builds. There are 594 frozen inputs and 595 physical copies. Current/frozen inputs, both emission sets and the pinned Node binary are verified unchanged after execution.

Fresh private source/output, HOME and temporary directories accompany the unchanged reviewed pidfd/subreaper supervisor: a 300-second per-phase cap, seven-second cleanup window and eight-MiB retained-output cap. These are bounded watchdog settings, not hard real-time or filesystem/network/cgroup isolation guarantees. Each process receipt distinguishes actual direct-child wait, observed owned-process exits, ECHILD, stream EOF and any supervisor intervention.

The fixture stops and joins the original serial loop, verifies its original receiver is closed, disposes the genuine resident, requires `processId === null` and zero native-lane use, then closes SQLite. Temporary-root removal additionally rechecks the original realpath/device/inode identity. Unresolved join/disposal retains the root. Supervisor process closure does not itself qualify application cleanup or authorize deleting unrelated roots.

Final author result: **6/6 passed**, zero failures/cancellations/skips/todos, natural Node exit 0 in 10.779514 seconds; supervisor total 10.810408 seconds. All eight observed owned process identities exited, ECHILD and both EOFs were confirmed, with no forced signal, deadline or error. Private HOME/temp were empty.

Independent final-source review found no blocker. Its separate fresh freeze passed the same **6/6**, zero failures/cancellations/skips/todos, with identical complete source and emission maps. Natural Node exit was 0 in 10.394197 seconds; supervisor total 10.424932 seconds. All eight observed owned process identities exited, ECHILD and both EOFs were confirmed, without forced signals, deadline or errors. All 594 inputs / 595 copies, emitted files and pinned Node were unchanged, and private HOME/temp were empty. The repeated six tests are not twelve distinct cases. Final source SHA-256: `20187fa2ad0b87f000aa47f92bdd9837fa3085e0b8d0f80d5ceb69d0d3eac8ed`.

Shared source-graph SHA-256: `686a8494fabfd1f45df418645b04a6bf3ab7ce6daed12dbbf825af6298377ac5`.
Production emission-map SHA-256: `79b1c6d41b4150c3695fd4ee66c04bae06a3a34f339606492ffef3358c50e8a8`.
Selected emission-map SHA-256: `c634b040796b84fb73843c77cf40a96e124b42ea20543e55ed97c3f2c01ebf18`.

## Remaining gates

This closes a genuine automatic-form installed-core integration gap. It does not install or exercise live Computer Use/browser connectivity, actual Discord transport, the HTTP startup wrapper or complete local-application semantic graph. No real-root acquisition was attempted; the established POSIX socket EPERM remains unresolved.

The persistent resident remains uninstalled. Moving its original serial receiver still requires reviewed mediation for both conditional prompt reads and native receipts/transport; the existing receipt-persistence seam is not a completed adapter. Authentic-root/physical-store exclusion, child containment, persistent component cleanup, held-service liveness, full completion-ACK ambiguity, Windows, provider/cutover, performance/endurance and original A–G acceptance remain separate. Historical v4 descendants remain UNKNOWN and untouched. These six cases are not an overall component or migration PASS.
