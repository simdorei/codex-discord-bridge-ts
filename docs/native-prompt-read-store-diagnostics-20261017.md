# Existing native prompt-read store diagnostics — checkpoint 968 WIP

## Result and scope

This slice restores a bounded subset of Rust store-failure classification through the **existing** native `Observed`, queue `List`, and intake `MirrorTarget` reads. It introduces no persistent transport, new worker entry, database operation, runtime activation, response capability or retry/release authority. It is not complete Rust diagnostic parity or a completed migration gate.

The direct `capturePromptAuthorityReads` port still propagates the exact original error object. Shared native adapters retain their existing outer error classes and messages. Only `createNativePromptAuthorityReads` unwraps a store diagnostic associated with that exact adapter error after a complete, validated original reply and actual native join. `PromptAuthorityError` continues to mean invalid authority; local server errors, read ordering, conditional short circuits, full queue decoding, generation/request revalidation, and the final synchronous response checks are unchanged.

The old workers discarded ordinary failures as `ok:false`. Known store failures are now distinguishable from absent, invalid or late native results at the prompt port. Transport/admission failure is not renamed as a store failure. Unknown source exceptions retain the previous fallback behavior.

## Immutable Rust reference

Repository `simdorei/codex-discord-remote-rust`, commit `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`:

- [server_prompt_authority.rs, lines 7–113](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/server_prompt_authority.rs#L7-L113), blob `000c612ad050850ed468306f693cc3f80288aa98`: `Invalid`, `Store`, `Server`; original conditional observed-completion, full queue and mapping reads.
- [server_request_worker/error.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/server_request_worker/error.rs), blob `56e98e94576c94096319183e26731a287fa87348`: transparent typed error propagation, not JavaScript reference identity.
- [server_prompt_redisplay.rs, lines 89–112](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/server_prompt_redisplay.rs#L89-L112), blob `ca8ccd8a0b6bdf286814d3cc89dea082a4e6efb7`: only invalid authority and prompt failures become an unavailable display; store/server failures propagate.
- [server_request_worker/recovery.rs, lines 69–85](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/server_request_worker/recovery.rs#L69-L85), blob `ddcacd116714ce4377951a49bc0dde3bad6eff7b`: shutdown selects and drops the future when polled. Synchronous SQLite is not preempted by that selection. TS retains its explicit cooperative wait and actual-exit joins; Tokio future-drop equivalence is not claimed.

These are inspected source references, not executed Rust artifact comparisons.

## Closed diagnostic boundary and ownership

`native-store-read-diagnostic.ts` recognizes exact nominal source error prototypes for `Integrity`, `InvalidQueueState`, and `UnsupportedVersion`. It recognizes a native `Error` with an own-data `code` equal to `ERR_SQLITE_ERROR`; the optional numeric SQLite code may be absent. The stored schema numbers are signed i64; SQLite codes are nonnegative integers at most 2147483647, excluding negative zero. Unknown prototypes, proxies, accessors and invalid field types cannot enter the supported projection.

The wire contains only these fixed classifications, schema version integers, optional numeric SQLite code, or `ScopeCleanup` with **exactly two** recognized nonaggregate children in primary/close order. That aggregate matches `owned-scope.ts`'s two-error construction. One child, nested aggregates, sparse arrays and any unknown child reject the entire projection. General cause-graph serialization is not provided.

The diagnostic value is limited to 512 encoded bytes; the fixed field/value domains fit that bound without truncation. Existing complete-envelope budgets remain 262144 bytes for Observed and 16 MiB for List/MirrorTarget. New failure replies bind the original operation and List filters or MirrorTarget channel; Observed retains its existing full request binding. No original binding becomes an execution capability.

Raw error messages, SQL, paths, row values, invalid state contents, `result`, `stack`, `errstr` and arbitrary nested causes are never inspected or included in the **diagnostic**. Existing request-binding fields, including Observed's original path/thread/turn, remain unchanged. Reconstructed messages are static apart from validated numbers. This deliberately preserves classification rather than Rust/native diagnostic text.

The pure decoder constructs data only. Each of the three adapters owns a private WeakMap from its exact outer error to the reconstructed store diagnostic. Enrollment requires the original submission to have been admitted, successful completion of the original `OwnedWorkerSlot.run`, `slot.join`, whole-reply bound validation and closed diagnostic decoding. Actual slot completion already requires one message, successful native exit and no worker failure. A public error constructor, matching properties or a pure decoded value cannot enroll an outer error.

Admission refusal, abort, timeout, worker error, nonzero exit, absent/multiple replies, malformed records and late replies bypass enrollment. No admission proof is consumed or reconstructed. Existing native budget/registration release still occurs only at actual exit. The prompt port unwraps only the corresponding adapter's private entry. Store errors do not subclass `PromptAuthorityError`, so redisplay cannot accidentally render them as invalid-authority UI.

This is not a defense against arbitrary trusted-code prototype replacement. Existing mock-based tests are passive branch checks, not evidence of a genuine worker or owner.

## Qualification

Final author qualification used fresh source/emission/home/temp roots, the pinned Node 24.21.0 executable and TypeScript 7.0.2. The explicit dependency traversal rejects protected paths before reading them. No broad repository test or full-app compile was run.

- Strict selected graph: 336 project modules plus 178 declaration files.
- Strict production graph: 328 project modules plus 178 declaration files.
- All 328 production JavaScript emissions are byte-identical between the two compilations.
- Four selected test files: new diagnostic tests (10), existing prompt-authority native tests (6), existing native control tests (6), existing control-port tests (2). Final author total: **24 passed, 0 failed/cancelled/skipped/todo**.
- New passive cases cover known classification, getters/proxies, sensitive-field noninspection, exact envelopes, fake error causes, aggregate rejection and unchanged direct-port error identity. Aggregate primary/close fault construction is passive coverage, not a real forced SQLite-close failure.
- New genuine SQLite/native cases cover missing stores without creation, invalid queue state, baseline JSON failure, duplicate mapping, unsupported schema, unchanged shared outer classes, all three operations timing out while a genuine exclusive lock is held, late replies without store provenance, and Control saturation without a queue.
- The new original `startRuntimeResident` fixture uses the real native composition and child. It verifies successful authority, Invalid display behavior, propagated Store failures during verification/redisplay, retained pending request, zero child answers and zero synthetic response rows. It does not execute the complete server-request delivery loop or HTTP path. Cleanup asserts original child closure and all native lanes empty.

The existing 300-second supervisor uses owned-process identities, pidfds and a subreaper; it does not target historical processes. Native Worker exits are checked by the original slot owner; OS child/process teardown is independently recorded by the supervisor. Application cleanup and supervisor-enforced disposal remain distinct. Final author execution exited naturally with code 0 after 11.450403 seconds (supervisor total 11.481366 seconds), with all owned processes exited, streams EOF, ECHILD, no forced signals and no supervisor errors. All 589 frozen inputs / 590 physical copies, current source inputs, emissions and the pinned Node executable remained unchanged; private home/temp were empty afterward.

Final author evidence:

- Root basename: `native-store-diagnostic-968-author-final-20261017-qJ7YMGlC`.
- Source graph SHA-256: `2acf5dee86dc9746180e597994b01e2722de9c42377df81bf1a517b50d25eed3`.
- Production emission map SHA-256: `d5988462a2ba9078741dd7eec75c8d8c3e068a848f76efb8c1038ff67aa1eb6d`.
- Selected emission map SHA-256: `d18cb7a151be57b5fcf955e854af23976be4cd8e3f8448a2fe0ee3f27b1eb628`.
- Test process receipt SHA-256: `2ee9fb0a6801f75787a64fa10c14a6262e423ae8a66bdf7d699d4a477989487d`.
- Post-test audit SHA-256: `7e7aa371a1f789421f02e518dba76f41ba13f8951911b668c1745dc64cf2d350`.

Independent final source/test review found no blocking issue. A fresh independent qualification reproduced both strict graphs, all 328 identical production emissions and **24 passed, 0 failed/cancelled/skipped/todo**. Its test process exited naturally with code 0 after 11.495733 seconds (supervisor total 11.526599 seconds). All owned processes exited, streams reached EOF, and the subreaper recorded ECHILD; there were no forced signals, errors, remaining processes or live pidfds. The independent post-audit verified all 589 frozen inputs, current source inputs, emissions and pinned Node bytes; private home/temp were empty.

Independent evidence:

- Root basename: `native-store-diagnostic-968-review-20261017-X2BjyymP`.
- Qualification manifest SHA-256: `e57cdd042de3589ae415577c4af8861bbdf49fe8dda5196fea6e9ab0ed20845d`.
- Source graph and production emission map SHA-256 match the author values above.
- Test process receipt SHA-256: `78f861c2be173d4d18dde2835c71eacaffcb0844698b758a97138808a5b92d14`.
- Post-test audit SHA-256: `49545fbafa2879244eba16cb2e4725bebfbee6984d7abeed22732c32567c5100`.

An earlier author run also passed 24/24, but preceded the final admitted-submission gate, exact-two aggregate rule and all-three timeout expansion. Only the final author and independent runs above qualify the final source/test delta. The reviewer made no source or test edits.

## Remaining limits and next gate

This is partial classification parity. `queue-read.ts` already converts baseline JSON failures into `StoreIntegrityError`; this slice leaves that source behavior unchanged and does not claim Rust's `Json` variant was restored. Unknown failures retain the existing fallback. Exact diagnostic text, driver-specific nested causes, JS object identity across isolates and arbitrary cause graphs are not preserved. Abrupt worker/owner loss and genuine cleanup-error aggregation were not exercised by these runs.

Isolation is partial: fresh private resources, sanitized environment, frozen inputs, bounded process supervision and owned teardown. There is no filesystem/network/cgroup/namespace isolation claim. Unix singleton socket attempts remain prohibited; no socket test was run. Historical v4 descendants remain unknown and untouched. Operational root exclusion, authentic persistent-root attachment, physical-store/external-writer exclusion and independent child containment remain unqualified. Full local-application/guard semantic compilation, live app-server/CUA installation, performance, soak, deployment and overall A–G PASS are not established.

The next persistent-migration gate remains the concrete complete original receiver/caller owner boundary with Rust domain failures preserved and TS bounded/cooperative ownership retained. This fix removes an existing diagnostic-loss defect; it does not install that owner or authorize crossing the authentic-root gate. Baseline JSON source-category parity is a separate small source change requiring its own direct-caller impact review.
