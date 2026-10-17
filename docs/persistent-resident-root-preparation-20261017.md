# Persistent resident actual-root preparation binding

Date: 2026-10-17 UTC. Status: **source and passive rejection qualification only**. Positive actual-root preparation and installed persistent-resident lifecycle remain **BLOCKED / NOT RUN** after this executor denied the unchanged POSIX singleton socket operation.

## Verified wiring and concrete missing contract

The local application acquires `PosixRuntimeInstance` before storage preparation and its existing resident startup chain. It still uses the in-process resident. The persistent worker's current modes are unstarted preparation and a disposable normal-component protocol that launches a fixed test responder. Neither mode is installed by `local-application.ts`.

Bare unstarted preparation releases its writer registration on actual Worker exit, including a quarantined exit, while retaining `rootDebt: true` in its own snapshot. Consequently, ordinary writer-count accounting alone could close after that exit and permit singleton release without discharging the preparation's logical debt. This is the specific lifetime gap addressed by the new source binding; the existing normal component's separate release predicate is unchanged.

## New source scope

`src/runtime/persistent-resident-root-preparation.ts` adds the internal `prepareRootBoundPersistentResident(instance, paths, runtimeId)` factory. It is not imported by local application startup, a CLI or a public barrel. It does not start resident services, a child, a gateway or a fixture scenario.

- Capture own root/mirror path values and runtime identity synchronously, before enrollment. Paths must be pinned and satisfy the existing singleton-root bridge-path relation. RuntimePaths remain structural captured paths, not resolver-issued credentials or certified physical-file identities.
- Require the original private instance through `PosixRuntimeInstance.prototype.requireHeldRoot.call`. A structural guard, callback, prototype-only object or Proxy cannot supply the class's private identity.
- Synchronously enroll and attach the existing accounting-only domain before constructing the original fixed unstarted Worker. The domain is retained privately and is never returned to the caller.
- Return the original ready Promise and captured original join Promise. Join alone cannot close the attached domain.
- Preserve an early invalid close's original refusal without caching it. Cache one legitimate normal close attempt. Close the domain only after original close and join succeed and the original snapshot proves joined, submitted, exited, registration not live, no root debt, and runtime not started. Recheck the original held root before accounting closure.
- Keep the attached domain open throughout preparation; seal and retain it on ready rejection, a debt-bearing original join, or failed legitimate close. The wrapper snapshot reports root debt if either original preparation debt remains or the private domain is not closed. Zero writers, actual Worker exit or fulfilled join alone cannot report debt-free root ownership.
- On synchronous construction failure, use only the existing `closeAfterOwnersJoined` check. If it refuses, preserve primary and cleanup errors and leave the original singleton retained. There is no force-close, replacement, retry or reconciliation authority.

The existing instance permits only its original accounting attachment. This factory does not add a way to recycle that attachment or start a replacement under unresolved ownership. Original path-only preparation and disposable component behavior, their Worker protocols, native deadlines, normal cleanup predicates and retained-debt witnesses are unchanged.

## Actual root baseline and environmental blocker

Before adding this binding, a fresh bounded run selected the unchanged `test/runtime/runtime-instance.test.ts` and `test/store/store-authority-domain.test.ts`. Strict compilation and production parity succeeded for 15 selected / 12 production project files, plus 178 declarations in each compiler file list.

Runtime result: **10 tests, four passed and six failed**, zero cancelled/skipped/todo. The real `PosixRuntimeInstance.acquire` socket listen calls failed with `EPERM`. A private short temporary path was used, so this was not the production socket-path length check. No actual singleton was acquired in those failing positive cases. The Node process exited 1 naturally, with its new process tree exited, ECHILD and output EOF confirmed and no supervisor signals or errors. Frozen project/emitted bytes were unchanged afterward; its private temporary directory was empty.

This failed result is retained. No socket retry, escalation, alternate locking primitive or synthetic acquired instance was used afterward. Positive root binding, exclusion, normal release/reacquisition and quarantine retention are therefore unverified at runtime. The passing passive cases below do not supersede this failure or close the actual-root gate.

## Exact passive qualification

Only these two emitted files ran after the blocker was established:

- `test/runtime/persistent-resident-root-preflight.test.js`
- `test/store/store-authority-domain.test.js`

The first contains three passive tests with fifteen rejection inputs: three fake singleton receivers; eight malformed, active, inherited or mismatched path records; and four invalid runtime identities. Path/runtime cases assert their specific validation errors so a later private-receiver failure cannot mask a missing earlier check. Getter/proxy/caller-method invocation counters remain zero. Existing native-lane usage and enrollment checks are supplemental cleanliness evidence, not a complete inventory of direct persistent Workers.

The second contains three existing pure accounting tests covering private domains/tickets, exact submission/exit bookkeeping, sealed completion accounting, passive path capture and forged singleton construction. It performs no genuine singleton acquisition. Neither selected file constructs a persistent Worker or a database, binds a socket, or exercises successful root preparation.

The final author run passed **6/6**, zero failures/cancellations/skips/todos, with actual Node exit 0. Selected and separate production compilation passed for 325 / 321 project files respectively, with 178 allowed declarations in each actual compiler file list. All 321 production JavaScript outputs matched their selected-build counterparts. An earlier candidate compiled but was not executed; review strengthened path-specific assertions before this final run.

The source received independent review, including combined root-debt reporting, one-shot legitimate close and unchanged early-refusal handling. Independent repetition is recorded below.

## Frozen execution evidence

Execution used pinned Node 24.21.0, the installed direct TypeScript 7.0.2 compiler, explicit strict NodeNext/ES2023 inputs with configuration bypass, and a guarded exact dependency closure. Protected paths were rejected before reads. Node argv used `--no-strip-types --test --test-concurrency=1 --test-reporter=tap` and the two exact nonempty file paths; there was no broad discovery or test-name filtering.

Each run had a separate frozen source/output tree, sanitized environment, private HOME and short private temporary directory. The previously reviewed supervisor retained its original-child/session/pidfd identity checks, 300-second execution limit, seven-second cleanup window and eight-MiB output bound. Natural wait completion, all owned exits, ECHILD and both EOFs were confirmed; no supervisor signal or error occurred. These are bounded watchdog limits, not hard real-time guarantees.

The author post-run check verified all 578 frozen inputs, all 325 current project sources, 325 selected and 321 production emitted files, and the pinned Node binary. HOME and the new temporary directory were empty. The old v4 descendant status and old roots remain UNKNOWN and untouched.

SHA-256:

- New binding source: `3167ae3c31821ba433053258772a4ae8efda2429f1939fa77316cbea79d1f92a`
- New passive tests: `bc42fdd3cb68286ab1538da1e5edb52caff4fe24729c1186aa02a2187f1c6a54`
- Source graph, sorted compact JSON: `2803e7a757bbb282d5281fdbc28313f12ce9bfb786389e52d212b4f65f565789`
- Selected emitted map, sorted compact JSON: `6e52bcfbe417a6660a21a47617f664e01dccb3de67269bc6923f1777d8515cae`
- Production emitted map, sorted compact JSON: `740e380948104943ef26715d501d1aa251796887b3539366c55e00c500288f3d`
- Reviewed supervisor: `5300f8782a9be6806e2c7f1fc9e3f06743d6de5ca6d7f788da59d126f8fa6f2e`
- Author result receipt: `1dd7ad6ce0bb63939b96ed79cb1390dba008c8cf7ea1b5889b7957b27ea6fce6`

## Independent repetition

The independent reviewer froze the same final source into a separate tree and independently compiled both exact graphs: 325 selected / 321 production project sources, each plus 178 declarations. Compiler exits were 0, production parity passed, and the complete source/selected-emission/production-emission maps matched the author's hashes above.

Its identical two-file passive/accounting run passed **6/6**, with zero failures, cancellations, skips or todos and actual Node exit 0. All owned exits, ECHILD and both EOFs were observed, with no supervisor signals or errors. All frozen inputs, current project sources, emitted outputs and pinned Node matched after execution. It made no socket attempts, acquired no real singleton, and executed no persistent application Worker, responder or database. These overlapping six-test runs are not additive coverage.

Independent final verification SHA-256: `dcdc0099d574d18ee2c68c20f469506a5c9e432ff493ed10108844f801314af5`.
Independent runtime process receipt SHA-256: `b5d46f53b575f32ff90254a6a11e12e42ed188cd0a214ab3669fef9913bc8b45`.

The independent result approves only the source/compile/passive scope. Positive normal release and retained-root quarantine remain unverified.

## Required next qualification

A suitable execution environment must permit the unchanged real POSIX socket operation. There, use fresh disposable roots and the real original acquired instance to test resolved paths, wrong-root/released-instance rejection, same- and separate-process exclusion, normal close/join followed by explicit singleton release/reacquisition, unsubmitted-construction failure, and deadline quarantine with root/accounting debt retained.

A quarantine probe holding a real singleton also holds a listening server. Its isolated process needs an explicitly bounded own-process closure path; process exit must be recorded separately from logical quarantine and must not authorize deleting retained fixture roots. Do not turn that negative case into a clean-close PASS.

Only after positive actual-root preparation is qualified should fixture-free persistent lifecycle composition and installed startup wiring proceed. No installed integration, production activation, normal-component aggregate PASS, physical external-writer exclusion, Windows, endurance, Rust cutover or overall migration completion is claimed. The separate mandatory protocol-negative component gate remains failed.
