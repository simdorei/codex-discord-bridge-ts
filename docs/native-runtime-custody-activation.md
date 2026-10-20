# Native pre-spawn runtime custody activation

Checkpoint 933 offloads only the pre-spawn pair of runtime-ID writes to the existing dead-generation Control worker. Post-spawn idle-journal/observation installation, response begin, Repair, synchronous final authority guards and the source lifecycle stay unchanged. This is not complete startup DB isolation, physical external-writer exclusion, Stage 893 activation, Windows qualification or production authorization.

## Source order and partial commits

The frozen Rust source is `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`:

- [RuntimeDeadGenerationFence::new](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/dead_generation_recovery.rs#L23-L40) checks the startup-channel i64 conversion, activates the dead-generation runtime, then activates mutation custody.
- [Dead-generation activation](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-store/src/dead_generation.rs#L15-L26) and [mutation activation](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-store/src/mutation_attempt.rs#L72-L83) independently open initialized storage and upsert their singleton marker. Prepared attempts and old incidents remain.
- [start_app_server](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/discord_runtime.rs#L317-L342) creates custody before the resident, then installs the idle journal. Installation failure closes that exact resident and preserves primary plus cleanup failure.

The worker executes `await state.activateDeadGenerationRuntime(path, runtime)` followed by `await state.activate(path, runtime)`. These remain separate existing operations, opens, initialization paths and commits. No combined transaction or Promise.all is used. First-step failure prevents the second operation; second-step failure may leave only the first marker changed. There is no retry, rollback claim, incident reset or replacement runtime-ID generation.

## Closed startup ownership

`NativeDeadGenerationOwner.startWithCustodyActivation` constructs one owner, invokes its private startup-only operation and returns the same owner for subsequent Capture. There is no public instance reactivation method. Existing direct construction still provides only existing-store Capture. Capture cannot initialize or repair a missing store/schema.

Original path spelling, runtime ID, startup channel, renderer and process/client configuration are captured before the first await. Relative paths are pinned against the original cwd and used throughout returned fallback hooks, fences, later native owners and idle installation. This pins spelling, not symlink or physical-file identity.

ActivateCustody is a closed discriminator in the existing worker family. A per-operation nonce and SHA-256 digest bind the entire request; the bounded ACK must match operation kind, nonce, path, runtime and digest exactly. That ACK is internal consistency evidence, not dispatch authority. Startup uses the existing zero-queue Control lane, the unchanged 5000 ms default and actual-worker-exit join. No worker pool, manifest entry or budget was added.

Cancellation, deadline, Control saturation, lost/duplicate/malformed/crossed ACK and crash reject startup. Accepted work retains its native registration and Control slot until actual worker exit, even after cancellation/deadline. Either or both writes may already be committed. No SQLite worker is terminated to imitate a join. The factory closes its owner on failure; a late pre-spawn cancellation also closes the returned owner. Only confirmed, joined activation permits resident spawn. Post-spawn failure still disposes the exact resident and preserves RuntimeResidentStartupCleanupError composition.

## Authority restriction

The original outer application must keep its actual singleton guard held across activation, resident spawn and initialize/initialized handshake. The local application owns that existing lifetime; direct startRuntimeResident callers contractually promise the same exclusivity. Accounting does not establish it, and this slice does not activate Stage 893 or claim external-writer exclusion.

initialize/initialized has no later DB mutation guard. Therefore those startup wires rely on that caller-held exclusivity plus acknowledged/joined activation. Ordinary mutation dispatch still revalidates the exact prepared receipt, original admission, client, generation, target and durable runtime marker immediately before write. No await was inserted into that final check/write boundary. A competing late marker change remains a refusal for ordinary mutation; it does not demonstrate a handshake guard.

The synchronous compatibility persistDeadWork and fence remain available. Their store calls remain synchronous and Capture remains existing-only. Native activation failures retain the central DeadGenerationFence mapping and public-safe renderer.

## Bounded offline qualification

The selected tests cover ordered and partial writes; old incidents and prepared attempts; main-thread helper poisoning; same-owner subsequent Capture; exact/crossed/missing/duplicate ACKs; crash/cancel/default deadline and retained actual-exit accounting; Control saturation; real SQLite lock wait with main-loop timer progress; no child before joined activation; cancellation after activation before spawn; original config/path under cwd change; both markers observed by initialize; and late ordinary mutation-marker refusal. Existing missing-store/schema Capture and post-spawn cleanup tests are retained.

Validation uses pinned Node 24.21.0 and TypeScript 7.0.2, explicit guarded source/test roots, private output directories, emitted JavaScript with --no-strip-types, actual compiler-file-list audits and source/emission parity. Protected redaction and remote-agent native-read paths are excluded before content reads or compilation. No broad repository run, Unix listen EPERM retry, live database, provider, native Windows, Git operation, upload or deployment is part of this qualification. Failed exploratory evidence remains failed and retained; passing later checks do not replace it.

### Checkpoint 933 author results

Base local `5917b7a2583053c3741d08d15e34cb8c5df34f0e`, remote `341fb624291e4e0350742de7e54e858c33b5c7d0`, tree `f52734c1988a23fced23d504bf782a764c7a3092`.

- Strict selected compile passed for 339 guarded production/test inputs. Source graph SHA-256: `27538922cdbae0824bb516a258e150a20729e3d54f5af03dbc2f6d654c15ee93`. Actual compiler file list matches the guarded closure.
- Separate production-only compile passed for 301 selected production modules; every emitted byte matches the selected test profile. Production source graph SHA-256: `b14a7c77fbb0952579c5efe230f788ee6c0123c16017759c0ebd0576aa066669`.
- All 228 tests passed across 19 exact test roots, with zero failures, cancellations or skips. The default 5000 ms resident-startup deadline scenario, actual native-exit retention, real SQLite blocking/main-loop timer progress and unchanged final-guard regression passed. No production or test timeout was raised for passing.
- All 339 guarded source/test hashes remained unchanged after execution. Selected profile: `.runtime/custody-activation-933-author-P9lFqR`; source-only profile: `.runtime/custody-activation-933-author-A30BEP`. Exact roots, compiler lists, hashes, parity and TAP are retained there.
- The initial selected compile in `.runtime/custody-activation-933-author-DYuKWv` failed a test-only TypeScript closure-narrowing check. Its failed log and emitted output remain retained. The test was corrected before any runtime run; production bytes were unchanged.

### Independent review and retained caveat

Independent scoped review found no remaining code blocker. Its guarded strict typecheck and two private builds audited 338 production/test inputs and 318 production-only modules; all 318 emitted production modules matched byte-for-byte. Its 18 exact emitted test roots passed 161/161, and a separate 12/12 adversarial probe run passed, all with zero failures, cancellations or skips. These checks overlap the author's selected coverage and are not additive full-suite counts. Source graph SHA-256: `674c247de0133080e760a8fc288cd9ea9fe483d9ca81cde8dd1c7dfd70513b59`. The independent receipt and exact selections are retained at `/workspace/shared/review933-independent/review-receipt.json`.

Reviewer history retains two failed compiles: initial private type-root setup, and the same candidate test closure-narrowing error corrected before qualification. It also retains an unintended no-argument Node test invocation: a shell sequencing failure expanded a missing argument file to an empty file list, causing automatic discovery from the repository root outside the guarded private emitted graph. Its TAP reported only `test/fixtures/pro-fingerprint/chrome/scripts/probe.mjs` (one pass); no compiler was involved. The discovery traversal/read reach was not independently established, and protected-path exclusion cannot be certified for that invocation. Its entire result is excluded from qualification. No discovery retry or protected-target inspection was performed. The later qualifying 161-test and 12-probe commands used guarded, nonempty explicit arguments in private compiled trees. Exact unintended-command evidence is retained in `/workspace/shared/review933-independent/unintended-discovery-record.json`.

The author run did not use automatic discovery. Its exact guarded roots, audited compiler lists and post-run source hashes support its separate 228-test result. The final eight-file freeze and consolidated receipt are retained in `.runtime/custody-activation-933-author-P9lFqR/final-freeze.json` and `author-handoff.private.json`. These bounded results are not a full-suite, production, Windows, stress/endurance or 24-hour qualification.
