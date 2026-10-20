# Persistent resident mutation cancellation: fixed negative qualification

Date: 2026-10-17 UTC. **The new cancellation invariants passed; cleanup and component qualification remain FAIL.** This is an uninstalled disposable component, not actual-root or operational runtime qualification.

## Concrete gap and scope

Checkpoint 948 qualified the worker-local mutation owner's direct Unknown hook, but only compiled the changed lifecycle cancellation path. Existing native-dispatch tests use the legacy native owner without that hook. Checkpoint 959's integrated cancellation scenarios concern responses. Neither selection established mutation cancellation through the real lifecycle, worker-local owner and sequential broker together.

This change adds one fixed negative scenario, `mutation-cancel-after-write`, to the existing disposable fixture dispatcher. The twelve normal scenarios remain unchanged and the negative case is kept outside their enumeration. Its separate `fixture-negative-result` report contains `assertionsPassed: true`, `cleanupQualified: false` and `componentQualified: false`. Exact report validation rejects success upgrades; main also refuses a negative scenario reported as an ordinary `passed: true` result.

Five internal source files change only fixture inventory, fixture execution and its result transport. There is no new owner, injected callback, adapter replacement, synthetic receipt, broker result, configurable executable or root substitute. The existing lifecycle, worker-local owner, sequential broker, native transport, responder, final dispatch checks and close/release predicates are unchanged. The default local application and CLI do not import this disposable composition or activate a persistent resident.

## Actual original-owner path

The fixed composition constructs the existing `PortableResidentLifecycle`, `ResidentLocalMutationOwner`, sequential client and main broker. It uses the original native mutation worker, real disposable SQLite and the unchanged fixed responder child.

1. Subscribe before submitting one settings mutation for `fixture-independent`, with an original AbortController signal and the existing fixture workflow credit.
2. Await the genuine responder's `fixture/mutation-held` notification and verify its generation and target. This notification is emitted only after the responder receives the original wire and retains its unanswered request. The request Promise must still be pending.
3. Capture the sole durable prepared row, checking runtime, resident owner, generation, method, target and nonempty attempt/wire identities.
4. Abort the original signal and require the exact same cancellation object. Compare the complete row, including its identity, scoped flag, request hash, state and timestamps, with the pre-cancellation capture. Generation and resident health stay unchanged.
5. Submit a new settings request for the different, otherwise clear `fixture-target`. It must reach the authentic closed owner and reject as `ClosedBeforePost`; the original target's durable hold cannot supply this proof. The full original row remains unchanged, with no completion or second attempt. The fixture workflow ledger is empty.

Only after these assertions does the worker emit its distinct negative result. The main test requests the original component close, requires its lifecycle/closing failure, and awaits the captured original join. The resulting snapshot remains quarantined: requester exited, registration liveness false, root debt true, servicesClosed false, mutation normal-joined false, and direct-child diagnostic unknown. Re-running the fixture and re-registering its root are refused. A read-only post-disposal observation confirms the original prepared row is still unchanged. The exact temporary root identity is checked and retained.

The nonce-bound test witness is produced only after those checks. A separate mandatory cleanup qualification in the same unfiltered test file then fails. No logical quarantine is discharged by an OS process exit, fulfilled join, or successful negative assertion.

## Author execution

The exact selected entry was `test/runtime/persistent-resident-mutation-cancellation.test.js`. It contains report-validation checks, the real negative scenario, and the mandatory cleanup qualification. No previous broad suite or normal-component selection was repeated.

Strict selected and separate production compilation passed for 314 / 312 project files, each with 178 allowed declarations in the actual compiler file list. All 312 production JavaScript files matched the selected build byte-for-byte. Node 24.21.0 and direct TypeScript 7.0.2 were pinned; emitted execution used `--no-strip-types --test --test-concurrency=1 --test-reporter=tap` with the one exact nonempty test path.

Result: **three tests, two passed, one failed, zero cancelled/skipped/todo**. The sole failure is the mandatory cleanup qualification. Actual Node exit was 1, naturally, after approximately 1.525 seconds. There was no assertion failure in the real cancellation scenario.

The unchanged reviewed pidfd/subreaper supervisor bounded this execution at 60 seconds, with its existing seven-second cleanup window and eight-MiB output limit. It observed the original Node process, test process and responder descendant; final owned pidfds were exited, ECHILD and output EOF were confirmed. No supervisor signals, errors or deadline occurred. This establishes closure of this new execution's processes, not debt-free application cleanup. The worker's conservative direct-child diagnostic remains unknown because its original whole-lifecycle disposal rejected.

Post-run verification matched all 567 frozen inputs (569 physical copies), 314 current project sources, 314 selected and 312 production outputs, and the pinned Node binary. One new negative root remains in its private temporary directory; HOME is empty. Old roots and the historical v4 descendant UNKNOWN status are unchanged.

## Independent review and repetition

Independent source review found no blocking issue. A separate fresh freeze and bounded run reproduced the same 314 / 312 project graphs, 178 declarations per build, production parity, two invariant passes and the sole mandatory cleanup failure. Actual Node exit was 1 naturally after approximately 1.489 seconds, with all owned exits, ECHILD and EOF confirmed and no supervisor signal, deadline or error. The independent negative root is retained separately. These overlapping runs are not additive test counts.

Independent post-verification also matched all 314 current/frozen project sources, 567 inputs, both emitted maps, the pinned Node binary and supervisor. Its read-only retained-store check found exactly the original scoped prepared settings mutation.

Complete source and emitted map SHA-256 values, sorted compact JSON:

- Source graph: `110f8e75dbf3641fd89e3b8c044aae37658e610667632489a507f37436dc8472`
- Selected emitted graph: `c540f1b2cd3f626996ea9be3c8f416bcef10ded5e095c4032a2fb7a8c22af139`
- Production emitted graph: `6a26ea4633e75da8aeb96257b87bbcb59f702e330b2ae9fd484733056b032250`
- Reviewed supervisor: `5300f8782a9be6806e2c7f1fc9e3f06743d6de5ca6d7f788da59d126f8fa6f2e`
- Author result receipt: `2bd4f27ee05ca24de7579fd3911734529c38537d3228bde58d59c2512e861479`
- Author runtime process receipt: `66d5c8dc3f10718754746836be024b96125b5dc7eb144d941e10c21d541a2393`
- Independent post-verification: `2c48a967a0d9ef1b9d6b1347066f676d58f421905a7247ca4f8621ea640de68c`
- Independent runtime process receipt: `b176c715e9e5eb840ffac269253fc5fbbe50ffa07d87e498226119a99d5621ad`

## Remaining boundaries

This qualifies only cancellation after a genuine child-receipt barrier while the original request awaits its reply. It does not independently cover every lifecycle catch/finally branch, cancellation during native begin/occupied status credit, completion acknowledgement loss, or held-service/same-target liveness. No cleanup repair, root release, replacement or replay is introduced.

Positive actual-root preparation remains BLOCKED / NOT RUN after the existing Unix socket EPERM. No socket retry, alternate primitive, escalation, recursive store-authority coverage audit, protected-path inspection, production activation or ref update was performed. The next installed-lifecycle prerequisite remains real original singleton/root qualification in a suitable authorized environment; this negative fixture cannot substitute for it. Windows, old-owner cutover, live provider behavior, performance/endurance and overall migration completion remain unqualified.
