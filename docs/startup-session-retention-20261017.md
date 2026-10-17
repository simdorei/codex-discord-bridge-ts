# Startup pending-session retention guard

Date: 2026-10-17 UTC. Base: checkpoint 963, local commit `664fb332c64e4aad1f45c7a67f98acbfa5ade9aa`.

**Source hardening and passive error-routing qualification only. Authentic startup-failure/root-retention integration remains WIP / NOT RUN. The installed local application's full semantic compile is NOT RUN in this scope.**

## Source-confirmed conditional gap

`PortableAppServerSession.startObserved` throws `PortableSessionCleanupPendingError` with the original session when startup cleanup returns without confirmed child exit and stdio closure. `PortableResidentLifecycle.start` can rethrow that error directly or preserve it inside an `AggregateError` alongside additional cleanup failures. `startRuntimeResident` then rethrows before the foundation/context can return an owner to the local application.

The local application's existing retained-ownership branch recognized a resident cleanup error, managed-remote retention, or started workers. It did not recognize this earlier pending session. Its following cleanup branch could therefore attempt outer controller/singleton release despite the error retaining unresolved session ownership. This is a source/control-flow finding, not a reproduced native leak or observed premature singleton release.

The separate first-native-closer rejection hypothesis is not established: current original native close methods await `allSettled`. No injected rejecting closer was used to claim that failure.

## Minimal change and ownership meaning

- `portable-session.ts` brands constructor-created pending errors in a private WeakSet and exports a retention-only classifier. It follows native aggregate `errors` lists, including subclasses and cycles, using passive own descriptors. It never reads a session, `cause`, getter, custom iterator or caller method and never changes an error object or list.
- Inspection is bounded by a 1,024-unit node/prototype/list-entry budget. An opaque native aggregate list, opaque native-error prototype chain or exhausted budget conservatively requires retention. These outcomes are uncertainty, not proof of a live owner. Plain shaped objects and proxies are not constructor-issued pending errors.
- `local-application.ts` calls that classifier in the existing retained branch before outer closers. The existing `LocalRuntimeOwnershipRetainedError` retains the exact original primary/aggregate graph and the existing owners object; `retained = true` keeps the stop owner as before.

No lifecycle error is rewrapped or replaced by the classifier. There is no new release, retry, disposal, replacement or reconciliation authority. Existing child-close predicates, native adapters, singleton acquisition and persistent-worker startup remain unchanged. This is an operational error-routing guard change, not a fixture-only change, and it has not been deployed or runtime-qualified.

## Exact author verification

The selected compiler roots were the new `test/app-server/startup-cleanup-retention.test.ts` and unchanged `src/app-server/portable-resident-lifecycle.ts`. Only the emitted new test file executed. There was no broad discovery, test-name filtering or native app-server fixture.

Strict selected and separate production builds both exited 0: **59 selected / 58 production project sources, each plus 178 allowed declarations**. All 58 production JavaScript outputs matched their selected-build counterparts. Compilation used the direct native TypeScript 7.0.2 binary, explicit guarded inputs, configuration bypass and strict NodeNext/ES2023 settings; the passive test used pinned Node 24.21.0.

The author run passed **8/8 passive checks**, with zero failures, cancellations, skips or todos. They cover direct/nested error identity, aggregate subclasses/cycles, forged shapes, getter/proxy/revoked-proxy avoidance, opaque lists, sparse lists/iterator avoidance and bounded uncertainty retention. Positive markers deliberately contain `undefined` instead of a session: no session/resource object was fabricated or exercised. These are error-routing assertions only, not authentic owned-resource or singleton-retention proof.

The first selected compile rejected a test-only direct assignment of `null` to the typed aggregate list. That frozen attempt remains recorded and was not executed; its production compile passed. The test now creates the malformed property with an explicit descriptor. Independent review also caught a revoked-Proxy ordering issue before the final run; proxy detection now precedes `Array.isArray`, with a passive regression.

Each execution used a fresh frozen tree, sanitized environment, private HOME/temp directory and the unchanged reviewed pidfd/subreaper supervisor: 300-second bound, seven-second cleanup window and eight-MiB output cap. The author test process exited 0 naturally in approximately 0.126 seconds. All owned test processes exited, ECHILD and both EOFs were confirmed, and no supervisor signal, deadline or error occurred. No application session, app-server child, persistent Worker, SQLite store or singleton was created. Private HOME/temp were empty afterward.

Post-verification matched all 312 frozen inputs (313 physical copies), all 59 current project sources, all 59 selected / 58 production outputs and the pinned Node binary.

`local-application.ts` was separately captured and its exact import, retained-branch ordering, unchanged primary propagation and stop-retention guard were source-checked. Its imports reach excluded remote dependencies, so it was **not included in either semantic build**. No stub, substituted dependency or weakened compiler setting was used to hide that limit.

SHA-256:

- Source graph, sorted compact JSON: `9587cf4a86812efac91890446a6580919f88c6429a9b1abfb612cb5eef9cebb0`
- Selected emitted map: `018b5d337530fb292d5a6a3f6cd6502f681aab5196c414fd0b7b89c1a09ea2d3`
- Production emitted map: `a80be42d9f967f9afaa50fd3164fe3ac1f77c9329252a20fe133946e128fa58c`
- Author post-verification: `50b19216a42aa1cb282d5318a05181142e0d3aa99e923835a3cee08793793e75`
- Author process receipt: `682daee225263554f49f88232e7f0b2cd03c88d37f7eac57e5ccdee24fa8c810`

## Independent review and repetition

Independent review approved the final source after the revoked-proxy correction. Its separate private freeze compiled the same 59 selected / 58 production sources, each plus 178 declarations, and verified all 58 production outputs matched. Its source graph and both complete emission maps are identical to the author's.

The same single passive test file passed **8/8**, with zero failures, cancellations, skips or todos. Node exited 0 naturally in approximately 0.126 seconds; all owned test processes exited with ECHILD and both EOFs, without signals, deadline or supervisor errors. All frozen/current project-source and emitted-output hashes remained unchanged. These repeated eight checks are not sixteen distinct tests.

The reviewer separately checked the exact local-application source delta: the retained branch precedes catch-side outer cleanup, keeps the original primary unchanged, and sets `retained` before throwing so the stop owner's disposal is skipped. It did not compile or execute that full application or claim native retention proof.

- Independent post-verification SHA-256: `36246d6359f7a75c2c0888087ca0ce12b14f80950388fa6781b742e9f6bee7c4`
- Independent process receipt SHA-256: `bd55afc6711a19ed941a7c0016dfe315db4c18f07829a2dd8a14e87bf3990293`

## Remaining qualification

No safe deterministic trigger for genuine `resourcesClosed = false` after failed startup cleanup has been established here. Mocked closes, fake live owners, synthetic error markers and inherited-pipe descendants cannot establish that result. A future actual-retention test needs an independently reviewed bounded native fault, original process/session evidence, a genuinely acquired root and verified owned-process teardown. Process exit must remain separate from logical cleanup debt.

The unchanged authentic singleton operation remains blocked by established Unix-socket EPERM. There were no socket retries, alternate primitives, protected-path reads, old-process/root actions or ref updates. Existing protocol/mutation-cancellation debt, installed persistent-worker wiring, actual Computer Use/provider configuration and execution, Windows, cutover, endurance and overall migration qualification remain open. The passive 8/8 result is not production or component PASS.
