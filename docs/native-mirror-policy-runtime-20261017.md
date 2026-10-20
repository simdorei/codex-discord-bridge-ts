# Native mirror-policy runtime qualification

Date: 2026-10-17 UTC. Scope: bounded offline installed-owner and fixed-transport tests. Production implementation files are unchanged.

## Result and exact selection

The unchanged four existing suites passed **123/123** before adding coverage. The final author and independent reviewer runs each passed **132/132**, with zero failures, cancellations, skips or todos. Its actual Node exit was 0 after 36.3 seconds. The independent run exited 0 after 36.1 seconds. Overlapping runs are not additive test counts.

The exact serial emitted-JavaScript selection was:

- `test/runtime/discord-runtime/native-mirror-policy.test.js`
- `test/runtime/discord-runtime/native-interaction-policy-wiring.test.js`
- `test/runtime/discord-runtime/native-message-policy.test.js`
- `test/runtime/discord-runtime/native-history-policy.test.js`
- `test/runtime/discord-runtime/native-mirror-policy-transport.test.js`

The invocation used pinned Node 24.21.0, `--no-strip-types --test --test-concurrency=1 --test-reporter=tap`, followed by those five explicit paths. There was no name filter, automatic discovery, source execution or repository-wide test invocation. The existing suites retain their own negative fault-injection tests; those are not mislabeled as unmodified native outcomes.

## New executable scope

Only `test/runtime/discord-runtime/native-mirror-policy-transport.test.ts` is new executable source. No production owner, transport, worker, capacity, query, lifecycle, error, timeout or cleanup contract changed. No production dependency-injection surface was added.

Nine new cases exercise:

1. Three actual shared Background workers refuse transport T and owner P submissions. Proofs reject wrong Promises/errors and remain one-use. Replaying the genuine old errors as real AbortController reasons during new admitted native work preserves error identity but creates no new proof. The old invocation retains its original one-use proof.
2. A real mirror worker occupies the single local slot through cancellation. Concurrent T/P calls receive genuine local-busy proofs; the original call joins actual exit before returning. A later actual refresh succeeds.
3. A genuine capacity rejection retains precedence over an abort issued after synchronous refusal but before owner continuation.
4. Invalid path, scalar limits, private policy receiver and pre-abort reject in their original order even while three real Background workers saturate capacity. Proxy traps are not invoked and a missing store remains absent.
5. Four paired direct-transport/owner cases observe a real worker exit for a complete or missing store, then abort in a microtask before the awaiting continuation. The observer verifies exit code 0, zero Background usage and an unsettled outward Promise. Direct T still returns its original raw success or read-failure response; owner P rejects the exact abort reason before validating that raw response. A missing-store call without that abort still throws NativeMirrorPolicyError.
6. At the first real worker's exit, a second actual mirror submission occupies the local slot before the first transport continuation resumes. The first T returns while the second worker is still active, proving it awaited its synchronously captured original join rather than a later slot join. The second worker also exits and returns its real result.

Exit observation uses a test-only Worker subclass that passes the original fixed filename and options unchanged to the real constructor. It only subscribes to actual exit and schedules the stated microtask. It does not replace worker code, input, output, run, busy, join or proof maps. Real Background saturation uses the existing OwnedWorkerSlot budget. Every newly started operation is tracked for cleanup, including partial admission and assertion-failure paths.

The older suites cover complete two-query result semantics, immutable policy replacement, static restrictions, bigint preservation, budgets, existing-only reads, installed ordinary/message/history owners, cancellation/timeouts, actual-exit retention and error classification. Their original worker instrumentation and fault-injection tests remain unchanged.

## Defensive join branch

The same-refusal-object join-rejection branch remains independently source-reviewed, **not runtime exercised**. With the current real OwnedWorkerSlot it is structurally unreachable: ordinary mirror submission captures a resolver-only idle Promise, while the completion form of join explicitly swallows completion rejection. Creating such a rejection would require replacing the real join implementation and would not establish native behavior. The transport still clears refusal eligibility and preserves finally rejection precedence should that contract ever change; no fabricated join failure was used to claim this gate passed.

## Frozen compilation and containment

The final selected graph contains 688 project sources; the separately compiled production graph contains 673. Both actual compiler file lists contain exactly 178 allowed declarations in addition to those project files. Both compiler processes exited 0. All 673 production JavaScript outputs match their selected-build counterparts byte-for-byte.

The installed direct TypeScript 7.0.2 binary was invoked with configuration bypass and explicit strict NodeNext/ES2023 inputs. Protected paths were rejected before graph reads. This is a newly selected installed-suite closure, not a reuse of the earlier compile-only graph/counts. The first preparation stopped before compilation because the conservative import regex matched an inert quoted repair-script string containing `@oai/sky`. A subsequent exact-file/exact-line check recognizes only that quoted constant; no package was installed or imported for it. That failed preparation remains retained.

Two intermediate expanded snapshots compiled successfully but were never executed. Independent review tightened test cleanup before the final snapshot: partial worker admission is inside try/finally, and all started promises are awaited even if an earlier assertion fails. Those earlier bytes and compile receipts remain preserved.

Each execution used a fresh private frozen source/output tree, HOME and temporary directory, and a sanitized environment without inherited credentials, loader flags or NODE_OPTIONS. The previously independently reviewed Linux supervisor pins its original child and verifies its new session/process group, tracks owned descendants with scalar ancestry and pidfds, and observes wait completion, ECHILD and stdout/stderr EOF. It has a 300-second execution limit and at most a seven-second cleanup window, plus an eight-MiB output cap; this is a bounded watchdog policy, not a hard real-time guarantee. No application execution needed supervisor signals.

The author receipt confirms actual exit 0, no signals/errors, all owned processes exited, no remaining descendants or live owned pidfds, ECHILD and both EOFs. All 941 frozen inputs, 688 current project sources and 688 selected/673 production emitted files were verified unchanged afterward. No temporary fixture roots remained in that new run's private temporary directory. These observations apply only to the new executions; the historical v4 descendant state remains UNKNOWN and untouched.

SHA-256 identities:

- New test: `282cc860bbc18eb819114bf5d36852d1834ca48465f5841a0fadffac677fba88`
- Source graph, sorted compact JSON: `6dd0b383d34de85b0738c4674db3c05974c7aebd551544062004d7dd1a38b908`
- Selected emitted map, sorted compact JSON: `0a0ec30b82a200a4c560e654a8291ff62253304831339566b6bd7684f4cde32a`
- Production emitted map, sorted compact JSON: `9e18fa4381a1671aebb5ffb8dd9aa304c32d6d16f1b0d8b15420cdab0b0ab15f`
- Reviewed supervisor: `5300f8782a9be6806e2c7f1fc9e3f06743d6de5ca6d7f788da59d126f8fa6f2e`
- Pinned Node binary: `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`
- Direct compiler binary: `4f2de678286401759b3fb4475bafe35b8f32b4b3a07d92642bbf37eadc9b34a4`

## Independent repetition

The independent reviewer approved the final new test, containment supervisor and frozen-graph boundary, then created a separate private source/output/HOME/TMP tree. Its two compiler processes each exited 0; actual file-list audits again matched 688 selected or 673 production project sources plus 178 declarations. All production outputs matched within that run, and the complete selected/production emitted maps and source graph matched the author identities above.

The identical unfiltered five-file serial selection passed **132/132**, with zero failures, cancellations, skips or todos. Actual runner exit was 0 after 36.1 seconds. The independent supervisor recorded no shutdown reason, forced signals or errors, no remaining owned descendants or live pidfds, ECHILD and both output EOFs. All 941 frozen inputs, 688 current project inputs, all emitted outputs and the pinned Node binary matched afterward. Its fresh HOME and temporary directories were empty.

Independent summary SHA-256: `920c074969080ce5000950ba89546bc4a811a2302a29674bf6de03e21dce9884`.
Independent runtime process receipt SHA-256: `af66a1d34ecb7593dbbe200b4fd6d994461c745abb2b68e23e4c93c826d5f6b0`.
A post-run audit tool submission had a JavaScript syntax error before any command executed; the corrected read-only audit completed. There were no independent compile/test failures or retries.

## Qualification limits and next gate

This closes the selected installed mirror-policy owner/transport runtime qualification on the tested Linux/Node profile, subject to the structural join-rejection distinction above. It does not qualify whole-runtime installation, physical singleton/root authority, persistent-worker relocation, Windows, Rust cutover, matched performance, endurance or the complete migration.

The separate persistent-resident component result remains 58/59 with its mandatory protocol-negative cleanup/component gate deliberately failing. Those retained-debt witnesses and roots are not reset, removed or reclassified by this passing mirror-policy result.

The next substantive integration gate is the installed persistent-resident lifecycle under the real singleton/root owner, with fixture-free production wiring and disposable resources. Its startup/disposal races, child-exit/join custody, original-root retention on uncertain cleanup, and failure/replacement paths need their own bounded implementation and independent qualification. This report does not authorize a production launch or claim that broader gate is complete.
