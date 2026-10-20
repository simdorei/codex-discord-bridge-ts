# Installed prepared-message SQLite measurement (929)

The reviewed corrected fixture and its bounded author result are recorded below. This additive test-only fixture runs the unchanged installed `createPreparedMessageHandler`, default 5,000 ms native journal and default 5,000 ms SQLite busy timeout. It does not change production behavior, admission/retry bounds, database settings, or historical measurements. 893 remains inactive and final synchronous guards remain unchanged.

## Frozen workload

Nine exact original IDs, 9007199254740993 through 9007199254741001, run harmless `!qa buttons`. There are 13 handler invocations: baseline, then three real-lock originals and one separate committed-Result/ACK-loss original, with one exact-ID duplicate observation and one distinct healthy recovery after each fault. Duplicates must execute no action and submit only Admit. Failures are never replayed. Expected journal submissions: Admit 13, Begin 9, Result 9, Confirm 5, Hold 4; total 40. Healthy cases each require a confirmed exact result row, exact action-result receipt and one matching HTTP payload. Handler fulfillment alone is not success.

For each real-lock fault, the exact original Begin runs unchanged and actually joins. Before its successful result is returned, an independent owned worker confirms `BEGIN IMMEDIATE`. The harmless pure QaButtons action then reaches the exact original Result, which is synchronously forwarded unchanged, preserving the native journal's immediate slot.busy admission observation. The independent lock holder releases at 6,500 ms from that forwarding anchor. Only the exact native journal module/Result operation/original ID/database tuple is wrapped. The actual native SQLite BEGIN call runs unchanged; start/end/busy outcome and connection PRAGMAs are observed. Normal ACK content is preserved. After the original module finishes, a test-only barrier retains its actual native exit until 7,500 ms from the same anchor. This is a real SQLite locking interval plus a separate artificial post-SQLite retention interval, not 7.5 seconds of SQLite blocking.

The native completion queue waits actual exit before exposing its rejection. The lower native timer is narrowly observed at its original registration immediately after that exact Worker constructor; the prior queue timer is excluded. Its actual remaining delay is recorded separately from the 5,000 ms completion budget. Its unchanged callback runs, then pre-exit Control=1 and unsettled-handler observations are captured. The original `OwnedWorkerTimeoutError` is checked after actual exit. This does not claim the public completion Promise rejected before exit.

Each real-lock original must become held and unconfirmed without a Result outcome or action-result receipt/send, with one staged hold notice and one original error report. The distinct ACK-loss arm has no lock: the actual Result commits, only that exact worker's ACK is dropped, and the same exit-retention barrier applies. Its actual Result payload must survive while held/unconfirmed. Every exact-ID duplicate is observed without reexecution. Every distinct recovery must succeed before the next fault.

## Measurements and bounds

One independent probe worker uses anchored 25-ms planned/sent/main-observed/ACK clocks and controls message injection. Failed/missing samples remain in accounting. Exact Worker construction/exit records are distinct from sampled lane maxima; samples never claim exact peaks or submission counts. Per-condition guards are 15,000 ms; whole subprocess 120,000 ms; caps 6,000 probes/20,000 events; maximum one fault, one lock holder and one probe worker at a time. No deadlines are extended after failure.

The temporary fixture owns its initialized DB, actual mock resident process over stdio, loopback HTTP and exact worker handles. Cleanup joins those owned handles and retains the fixture if an exit is uncertain. No native DB worker is terminated to manufacture a join. Actual Node/SQLite versions and connection PRAGMAs are recorded without changes. The action/error receipt route still contains synchronous receipt leaves after the lock releases; this is not an all-database isolation claim.

## Reproduction

Use the pinned runtime and selected compiler only:

    NODE_OPTIONS=--no-strip-types .runtime/node24/node_modules/node-linux-x64/bin/node --no-strip-types tools/run-sqlite-lock-measurement.mjs --compile-only

Review the frozen plan, sources, selected graph, compiler actual file list and emitted graph before the first execution. Then pass the returned private profile directory:

    NODE_OPTIONS=--no-strip-types .runtime/node24/node_modules/node-linux-x64/bin/node --no-strip-types tools/run-sqlite-lock-measurement.mjs --run-reviewed PRIVATE_DIRECTORY

The four explicit roots are the probe worker, lock holder, original native journal worker and new focused test. The dependency walker rejects the protected redaction test, restricted remote native-read paths and reserved Windows paths before reads. TypeScript 7.0.2 strict ES2023/NodeNext emission rewrites imports, audits the compiler actual selected graph and retains private manifests/logs. Emitted JavaScript and workers run with `--no-strip-types`. No broad build/test or Git command is invoked.

This is partial synthetic G3/G4 evidence only. It cannot close G3/G4, qualify performance, prove a matched Rust comparison, all-lane responsiveness, provider/live-database operation, native singleton exclusion, Windows/G7 or migration readiness. No UNIX-listen EPERM retry or alternative singleton qualification occurs.

Pre-run source review corrected two harness hypotheses before execution: lock acquisition must follow joined Begin rather than await inside Result submission, and exact-ID duplicates emit no additional runtime report. No workload count, timeout, expected persistence outcome or acceptance bound changed; no runtime had executed.

## Preserved first-runtime failure and reviewed correction

The first reviewed profile `391ee2e217f132c7304ed2227a69cdc41aa8eaf0d2c2d7f08abbf70f5ac700a1` failed baseline before any lock/ACK-loss fault. Its proposed `!qa_buttons` input is slash-only syntax, unsupported by the prefix parser. It submitted Admit and Hold, and emitted the original unknown-command error. All five constructed workers exited, all lanes returned to zero, and cleanup had no debt. Full private failed-report SHA256: `8c039a46d47bf0c2ed815d06c79c97697375326976cee5f6344b772da25b955a`. This failed run is retained; it is not counted as a completed fault experiment.

The source-supported correction is `!qa buttons`, mapping to the same harmless QaButtons action, now checked by pure prefix and message-plan preflight. Counts, fault arms and deadlines are unchanged. The failed run also exposed a probe shutdown race: 15 probes sent, 14 acknowledged before immediate snapshot. The corrected stop freezes its observation cutoff and stops scheduling, then a FIFO stopping/finish-stop handshake joins already-issued ACKs before snapshot. Due-but-unsent/missing records are retained. It does not extend observation time or guards. The runner now creates logs exclusively, preventing accidental evidence overwrite. Both corrections received another independent frozen-profile review before the corrected execution.

## Frozen corrected profile and author outcome

The corrected profile was independently inspected before its first execution. All 631 selected source and emitted modules, the compiler actual project-source list and runner hash matched the manifest. Five compile-only development candidates completed successfully; no broad build or test suite ran. The first four compiled candidates preceded the preserved baseline failure; the fifth contains the reviewed spelling and shutdown corrections.

- Source graph: `778612e3f4aab25678d6a56b48425f4a174c26bb95b7b55b13d9759a3f80fa64`
- Emitted graph: `8b351bbd1173c6bc0bdb79d924a7230f7da1bb9c5d924743144bc64980bb7f6e`
- Profile: `6eeedf3c0378ec349958eee94648c21cdae18f35c12cf785332d75ff675b377d`
- Runner: `c160077b3528f669e3705151af97dc4a4034742cae342b321fa4d52121e3b322`

The corrected author execution passed the complete 9-ID/13-invocation/40-journal contract. All three real-lock originals produced actual SQLite busy failures, retained the native Control holding and unsettled handler after the real lower timer fired, joined actual exit, then staged exactly one Hold. Their rows remained held/unconfirmed without Result outcomes or action-result sends. The separate ACK-loss original committed its actual Result, lost only its exact ACK, and ended held/unconfirmed with that payload intact. All four duplicates submitted only Admit and caused no new reports, action-result sends or reexecution. Baseline and four distinct recoveries each recorded the expected result, confirmed its receipt and produced one exact action-result HTTP payload.

Actual runtime was Node 24.21.0 and SQLite 3.53.4. Setup and each selected Result connection reported busy_timeout=5000, journal_mode=delete, synchronous=2 and foreign_keys=0. No settings were changed. The three observed original SQLite BEGIN calls lasted 5007.85/5007.77/5007.83 ms before busy errors. Their separate post-module exit retention lasted 2405.84/2409.08/2404.36 ms. The ACK-loss arm's SQLite BEGIN succeeded, and its post-module artificial retention lasted 7412.69 ms. These are descriptive observations of the declared fault setup, not acceptance thresholds or performance qualification.

Exact constructor/exit accounting observed 66 native workers (40 journal, 13 classification, 13 mirror-policy), three independent lock holders and one independent probe: 70 constructed and 70 exited. Exact Worker lifetime peak was three total, one in each role; this is distinct from 25-ms sampled lane maxima (Background 1, Control 1, other lanes 0). All lanes finished at zero; cleanup joined the owned handlers, native/helper workers, HTTP and resident process without debt.

All 1,426 planned probes were sent, observed and acknowledged. During the three actual SQLite calls the main thread observed 200/201/200 independent probes; during their separate artificial exit-retention intervals it observed 96/96/96. The ACK-loss post-module interval contained 297 observed probes. Signed planned-to-send skew includes a minimum of −0.669 ms; early timer observations are retained rather than clamped. Latency distributions include every observed sample, and handler-settlement distributions include the four held/unconfirmed failures as well as healthy and duplicate observations.

The [bounded 929 evidence](../test/fixtures/sqlite-lock-measurement-929-summary.json) records original IDs, state outcomes, exact counts, connection settings, fault interval boundaries, sampled probe details, complete-sample distributions and the separately preserved failed candidate. Author full private report SHA256: `c8f0cb984d034950788b8ff67cdf6b9eb639e0317ba93e8634904cd00de7e74f`. Raw logs, full probe/event reports and private compiler manifests remain unpublished. An independent fresh compile and rerun of the identical frozen profile also passed, as recorded below.

## Independent corrected-profile rerun

A separate selected compile reproduced the exact source/emitted/profile hashes. Its focused execution passed all 13 invocations, nine IDs, the exact 40-submission journal contract, all four fault arms and their duplicate/fresh-recovery checks. All 70 owned workers exited; every lane ended at zero with no cleanup debt. All 1,419 planned probes were sent, observed and acknowledged. Timing samples remain separate from the author distributions.

Independent report SHA256: `374b8a62b11a4b138c99e0349112433ee385971034b301e39474e2d20a1a57e7`. Its three actual SQLite waits lasted 5007.90/5008.37/5008.80 ms; their separate post-module retention lasted 2411.61/2407.21/2407.02 ms. All four actual native timer delays were 5,000 ms. Exact fault rejection, Hold submission and handler settlement occurred after the matching actual worker exit.

These are two passing executions of the corrected bounded synthetic scenario, plus the separately retained failed first fixture. They do not establish reliability, throughput or whole-runtime acceptance, and leave the migration completion gates unchanged.
