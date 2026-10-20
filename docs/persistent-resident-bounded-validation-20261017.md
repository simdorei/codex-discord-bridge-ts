# Persistent resident: bounded isolated validation

Date: 2026-10-17 UTC. **Twelve fixed normal-component scenarios passed in separate author and independent reviewer runs. Overall component qualification remains FAIL.**

## New execution scope

The user authorized resuming with a time bound. This run used newly allocated private working, HOME and temporary directories, a frozen explicit source graph, sanitized environment and independently reviewed process containment. It did not reuse old fixture roots, signal an old or guessed process, reset application debt, or assert that elapsed time proved previous termination. The old v4 descendant state remains UNKNOWN and its files remain untouched.

The Linux supervisor verifies its own subreaper setting, launches the original process in a new session/process group, and pins its exact child identity before setup. Descendant discovery retains scalar PID, parent, start-time and session identities, verifies the pinned parent, and signals through pidfds. The configured execution limit is 300 seconds, followed by at most a seven-second cleanup window; this is a bounded watchdog policy, not a hard real-time guarantee. Output retention is capped at eight MiB. Receipts distinguish actual direct-child wait status, adopted-child waits, pidfd exit observations, waitpid ECHILD, stream EOF, signals, discovery errors and application qualification.

The first synthetic containment probe failed because this executor does not expose per-thread proc children files. It ran only fixed inert sleepers, no application or database, and its incomplete descendant evidence is retained as a failed probe. The corrected scalar-ancestry supervisor was independently reviewed and exercised against a child/grandchild deadline and a Worker-created child that ignored TERM. The latter required KILL and established actual waits, ECHILD and EOF. These probe results neither qualify application cleanup nor repair historical evidence.

Final reviewed supervisor SHA-256: `5300f8782a9be6806e2c7f1fc9e3f06743d6de5ca6d7f788da59d126f8fa6f2e`.

## Preserved first result and correction

The first unchanged-source run compiled 316 selected project files and 312 production files, with 178 declarations in each actual compiler file list. Production JavaScript matched between both builds. Its exact serial test selection reported 50 tests: 43 passed and seven failed, with no skips, cancellations or todos. It exited 1 after approximately 41 seconds, without supervisor signals; own-tree exit, ECHILD and both output EOFs were confirmed.

The first normal failure was `response-begin-refused`. The next five normal scenarios failed in the same process. Separately bounded original-source diagnostic runs reproduced the first failure, while `response-unknown`, `observation-gap`, `idle-transition`, `normal-replacement` and `final-row-changed` each passed alone. Each diagnostic used fresh private resources and confirmed process closure. This supports a retained-debt cascade after the first assertion failure rather than five separately reproduced defects.

The fixture incorrectly attempted a successful response on the same original occurrence after durable begin had refused. Existing response-client semantics and tests intentionally retain a normal response claim as indeterminate after preflight failure. Removing the SQL trigger cannot authorize replay.

The correction changes only the disposable fixture and adds a response-client regression. It checks the original owned MutationHeld failure, owned indeterminate classifications on subsequent attempts, one captured/released receipt, zero durable response rows, zero responses observed by the actual child, no pending replayable request, and a still-unsettled original occurrence. The regression verifies that removing refusal does not reenter preflight, start a write or emit a frame. Production response-claim behavior, normal root-deletion predicates, protocol quarantine and the mandatory aggregate qualification gate are unchanged. Independent source review found no blocking issue.

## Corrected author qualification

Pinned Node 24.21.0 and the installed direct TypeScript 7.0.2 executable were used. The selected graph contained 317 project sources; the separate production-only graph contained 312. Both compiler exits were 0, both actual file-list audits included exactly 178 allowed declarations, and all 312 emitted production files were byte-identical. Protected paths were rejected before graph reads; no broad test discovery or repository-wide compilation was used.

The serial test argv explicitly named these four emitted entries:

- `test/runtime/persistent-resident-normal-component.test.js`
- `test/runtime/persistent-resident-component-report.test.js`
- `test/app-server/response-attempt.test.js`
- `test/app-server/response-client.test.js`

Result: **59 tests, 58 passed, one failed, zero skipped/cancelled/todo**. The test process exited 1 after approximately 22 seconds. The supervisor sent no signals, recorded no errors, confirmed all owned processes exited, observed ECHILD and both output EOFs. Frozen sources and emitted bytes matched again afterward.

All twelve normal scenarios passed with the unchanged debt-free normal-close assertions: startup/close, ordinary/queue/stop, large response, bounded concurrent response, cancellation before and after post, begin refusal, unknown completion, observation gap, idle transition, replacement and final-row change. Concurrent response remains limited to child-reply wait; it does not qualify occupied native-status credit or same-target held-service liveness. Replacement retains the existing conservative direct-child diagnostic of unknown.

All three isolated protocol wrappers passed their exact real-child/TAP/nonce-bound invariant checks. Their witnesses still state retained root debt, cleanupQualified false and componentQualified false. The mandatory cleanup/component gate consequently failed. Exactly three protocol-negative temporary roots remain retained; the normal roots were removed only by the unchanged proven-normal-close predicate. Supervisor process closure does not clear logical quarantine, authorize removal of retained roots, or turn this aggregate result into PASS.

Source graph SHA-256 (sorted compact JSON): `277e8e396120942b263fc6f155b43f6219ea71155a91c35a68eb02eb275dd878`.

Production JavaScript hash-map SHA-256 (sorted compact JSON): `b3842c57f767bf6e41739846d88564fa826b9c44813c29ae60c9b2b50fe42f4d`.

Changed source SHA-256 values:

- `src/runtime/persistent-resident-composition.ts`: `bbc5d2c39b825bb2cd8b100f9bd9be6cf891449b4fe823847d3d9e2f958e6925`
- `test/app-server/response-client.test.ts`: `a1ac45b9df2f29b122520aa9b363ad81d46c5d4c84a3bdc88191d94570d87276`

## Independent repetition

The independent reviewer froze the same current source bytes into another fresh directory and separately compiled both explicit graphs. Its actual file-list audits again contained exactly 317 selected or 312 production project files plus 178 declarations. All 312 production outputs matched within its builds and matched the author's production hash-map above.

The reviewer then ran the same unfiltered four-file serial test selection: **59 tests, 58 passed, one failed, zero skipped/cancelled/todo**. All twelve normal scenarios and three protocol-only wrappers passed; the sole failure remained the mandatory cleanup/component qualification gate. The test process exited 1 after approximately 20 seconds, with no supervisor signals or errors. Its original process tree, ECHILD and both stream EOFs were independently confirmed. Three protocol-negative roots remained, no normal-case roots remained, and source/input/emitted hashes were verified unchanged after execution.

The matching complete selected emitted JavaScript hash-map SHA-256 (sorted compact JSON) is `ee90897493e062e916ba25f2818c6100d76edbc5c366bb49596add44f3dd07c0`. These separately recorded results are not additive test counts and do not change the deliberately failing component acceptance result.

## Remaining boundaries

This is a bounded fixed disposable component result, not an installed runtime, whole-component PASS, full original A–G or G1–G7 gate, operational singleton, Windows process-tree, old-owner cutover, matched Rust performance or long-duration qualification. Protocol cleanup debt remains explicitly unqualified. Earlier v3/v4 failures and v4 descendant uncertainty are not superseded by these new process receipts. No production service, main merge, ref update or publication was performed.
