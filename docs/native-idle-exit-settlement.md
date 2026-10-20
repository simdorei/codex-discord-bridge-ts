# Exact old-child idle settlement offload

Checkpoint 932 moves only the installed resident's post-confirmed-old-child idle settlement to the existing `NativeIdleBeforeOwner` and `native-idle-before-worker`. It adds no worker family, store schema, worker budget or SQL transaction. Stage 893 remains inactive. This does not complete startup/restart database isolation or qualify the runtime for deployment.

## Original identity and ordering

Under the existing restart lock, the lifecycle captures the original owned session, resident `instanceId` and exact bigint generation before cleanup awaits. After that session's `dispose()` and actual `processExitConfirmed` proof, it invokes the legacy synchronous `ResidentPersistence.oldChildExited` hook first. An explicitly installed optional `ResidentNativeIdle.settleExitedOwner` capability then replaces the synchronous idle journal's exit persistence. Without that capability the existing synchronous journal fallback remains. Both persistence routes never run for the same attempt. Async legacy hooks remain rejected.

The installed capability shares the existing idle native owner. It runs only `StateAccessFacade.settleExitedIdleOwnerExisting`, which opens the existing store and performs the unchanged autocommit statement:

`UPDATE cdr_idle_release SET state='Settled',detail='OldServerExited',revision=revision+1 WHERE owner_id=? AND generation=? AND state!='Settled'`

All non-Settled phases for that exact owner/generation settle once; already-Settled rows and foreign owners/generations remain unchanged. The resident instance ID is not the startup runtime ID. No transferred DTO can prove child exit. The store leaf and worker do not establish that proof; the original lifecycle owns it.

## Confirmation, uncertainty and retry

The existing Control completion lane retains each accepted worker and its registration through actual worker exit. Default deadlines, limits and queue capacity are unchanged. One exact bounded acknowledgement binds operation, pinned store path, owner, bigint generation and a per-call nonce. The parent accepts only one result with the exact envelope and acknowledgement fields, after actual exit. Missing, duplicate, malformed, crossed or lost acknowledgement, crash, cancellation and timeout are failures even if the SQL already committed.

Failure keeps the original sealed generation, session and usable idle owner. No successor, session removal or `finishCurrentClose` occurs until confirmed settlement and actual native join. There is no automatic retry of unconfirmed native exit settlement: the supervisor checks the retained obligation under the restart lock, including when queued behind a failing explicit attempt. A later explicit restart or close may retry only the original identity. The unchanged `state!='Settled'` predicate makes that confirmation retry idempotent.

A restart caller's cancellation is not passed into settlement after cleanup starts. The original operation is joined, then the existing caller cancellation check prevents successor startup. Confirmed settlement is cached by the exact retained session, owner and generation, so a later explicit retry after caller cancellation or another cleanup failure does not repeat SQL or call a closed idle owner. Unconfirmed results are never cached as success.

Terminal close still joins managed observations, preparations, idle work, dispatch and gap work and preserves cleanup error aggregation. The idle owner stays usable through settlement and explicit failure retry. Only after confirmed settlement does close close/join that owner; client retirement additionally requires successful child cleanup and native cleanup. A missing exit proof fails closed. Repeated successful close does not submit another settlement.

## Preserved boundaries

Final synchronous mutation validation, response begin/capture, Repair, idle verification, startup activation and wire-authority predicates remain unchanged. There is no automatic RPC replay, wider target permission, initialization of a missing database, SQL batching, new runtime identity or changed final mutation ordering. Child proof covers the existing portable direct-child owner only, not descendant process trees or native Windows qualification.

Validation uses disposable databases and child fixtures, pinned Node 24.21.0 and TypeScript 7.0.2, explicit guarded roots and private emitted JavaScript with `--no-strip-types`. Protected redaction and remote-agent/native-read paths are excluded before reads or dependency traversal. No broad repository build/test, Unix-listen EPERM retry, live database, provider call, native Windows, Git mutation, upload or deployment is part of this slice. Historical evidence and existing qualification limits remain authoritative. The focused results below are not a full-suite or performance/endurance qualification.


## Checkpoint 932 verification results

Baseline: local `acb9d8c00b7df85a0442c2c86cb1589befdcf820`, remote `244b2c5ecaff63b418af5f3fecdbd4412d585642`, tree `e339cb0e9216379381525a701aaa5fe5bb6475fc`. Author final profile: `.runtime/idle-exit-932-author-VJajmb`.

- Pinned Node 24.21.0 and TypeScript 7.0.2 strict compilation passed for 320 guarded selected modules. The actual compiler file list exactly matched the independently reviewed graph. Source graph SHA-256: `1b1c809b91d277a73cb4dfa8c5b59aec900ea5e75e3c5d677b927fc9821e5402`; emitted graph: `ec259b562c6a35cc38a557beba1b69f128129779907d1e36807604d00d9e945b`.
- Separate source-only compilation passed for all 301 selected production modules, with an exact actual-compiler-list audit and byte-for-byte parity against the test profile. Source-only graph: `bd5b7b641dd61382fe17da5d349d8d6a2326ea40df857241a718eda4b1c9d7e9`; emitted production graph: `d4855cc1d31cf16c89dabc78637a2804720c2a3357e9b5f67866e6696768a7ed`.
- Final author run: 169/169 across 17 explicitly named test roots, zero failures, cancellations or skips. Exact roots, module hashes and logs are in `compile-manifest.private.json`, `measurement.private.tap`, `run-receipt.json` and `production-parity.private.json` under the final profile.
- Independent review passed 180/180 across 18 roots, including the existing restart-supervisor regressions, plus 1/1 supplemental test for a session cleanup error after confirmed process exit. Its separate 321-module strict compile and 301-module source-only byte parity passed. These overlapping runs are not added into a unique full-suite total.

### Historical failure and separately declared timeout evidence

The first author run in `.runtime/idle-exit-932-author-38TPSG` passed 167/168. Its 30 ms timeout fixture correctly retained the first uncertain operation through actual exit and observed its committed settlement, but the subsequent cold-worker retry failed under that same deliberately short 30 ms deadline. Independent review reproduced the failure at 178/179. That original cold-retry scenario remains failed evidence. Its exact original TypeScript snapshot, original emitted JavaScript, hashes and TAP are retained; it is not relabeled as passing.

An intermediate 1000 ms fixture proposal was compiled only in `.runtime/idle-exit-932-author-871SuM` and was never executed. It supplies no recovery evidence. The initial fixture accessor type error is retained in `.runtime/idle-exit-932-author-LyTKDo`. Subsequent test-contract refinements in `vOgwqv` and `q39RMy` were also compile-only. No production timeout, default, worker limit or SQL changed to obtain a pass.

The final evidence distinguishes two scenarios:

1. The explicitly named 30 ms timeout-only case qualifies lock/event-loop and actual-exit ownership assertions only. It does not qualify the historical cold retry.
2. A separately reviewed source-default scenario omits the constructor timeout, exercising the unchanged 5000 ms default. It holds a real SQLite lock for 100 ms after actual worker facade entry, then releases that lock and observes the committed row. It separately retains actual worker exit until monotonic submission time plus 5200 ms, so the timeout is induced by post-commit exit retention, not a five-second SQLite busy wait. The caller remains pending and the Control slot remains owned until exit is released and joined. The failed attempt is then followed by exactly one fresh, explicit same-owner retry under the unchanged source default; it confirms settlement without incrementing the original row revision again. That separate scenario passed in both final profiles.

Bounds were frozen before execution: 10000 ms trace containment, 15000 ms fixture exit wait, and 20000 ms test containment. There were no warm-up-until-pass runs or automatic retries. The profiles are bounded offline functional evidence, not measured production latency, memory, process-tree, native Windows, crash/load endurance, live deployment or 24-hour qualification.
