# Synthetic runtime saturation and drain measurements (917)

This test-only harness measures the already installed [912 synthetic remote root](synthetic-remote-runtime.md). It changes no production source or authority. It runs real temporary SQLite, the existing mock app-server process, loopback HTTP/WebSocket transports and emitted native codec workers through `runLocalRuntimeApplication`. It uses the existing deliberately synthetic singleton acquisition/release seam. Native UNIX exclusion and the known bind EPERM case are not exercised.

The result is **partial G2/G4 evidence with a failed count-saturation recovery case**, not whole-runtime acceptance. No numeric latency acceptance criterion or matched frozen Rust experiment exists. Numeric timings are observations, not an SLA, performance PASS, Rust comparison, production readiness or deployment approval. 893 remains inactive and 913 remains unqualified/uninspected by this harness.

## Workloads fixed before observation

The source-defined connection limits are four active operations, sixteen total retained operations (active, waiting and completed-but-uncollected), and 4,194,304 declared UTF-8 wire bytes. These are admission limits, not measured heap limits or a throughput recommendation.

Each scenario creates a fresh synthetic root and four project sessions:

1. **Held versus unrelated:** hold one synthetic write leaf, inject an unrelated project write, require its exact-ID successful wire result before releasing the held leaf, then require the held leaf's successful result and joined shutdown.
2. **Count saturation:** hold four leaves, independently inject twelve additional candidates and one overflow candidate, require the original overflow ID's `operation_error/bridge_busy`, then release the leaves. Recovery requires all sixteen workload IDs to receive `write_file_result`, exactly sixteen starts/settlements and one refusal. An error response cannot substitute for a successful workload result.
3. **Byte saturation, cancellation and drain:** hold four small leaves, inject five queued candidates containing 400,000 `é` characters each, followed by a sixth oversized-for-remaining-capacity candidate. Each queued content is 800,000 UTF-8 bytes before JSON framing. This exceeds the outer wire-byte limit while staying below sixteen total commands and avoids the dispatcher's separate active-command text charge. Require the overflow ID's exact refusal, request shutdown, observe cancellation at all four still-held leaves, verify singleton/identity retention, release the leaves and require joined cleanup. The five queued candidates must never enter the leaf. Their missing wire results stay explicitly unobserved, not invented cancellation or delivery receipts.

The per-condition safety guard remains 15,000 ms and the test termination guard 60,000 ms. They are test safety bounds, not acceptance criteria. A newly observed connection/driver/send failure ends a wait immediately; the safety guard is never extended to hide failure. The harness does not replay a workload on reconnect.

## Independent stimulus and measurement boundaries

A separate worker thread owns the remote and mock gateway servers and schedules input independently of the runtime's main event loop. Large wire identity hashing is completed before timed sends. `injectedNs` is immediately adjacent to the `WebSocket.send` invocation, **not** an internal runtime receive timestamp or kernel-arrival claim. Planned injection, actual send invocation, callback completion/failure and wire result receive callback are separate observations. Callback success accepts both `null` and `undefined`, as required by the installed transport. Every input's exact UTF-8 byte count, SHA-256 and original string ID are retained; no payload text or credentials are published.

The same driver schedules 25 ms observation probes from an anchored monotonic schedule. It records planned time, actual driver send time, main-thread observation and driver receipt of the acknowledgement. Late ticks are not rescheduled from “now” to conceal delay. All timestamps use `process.hrtime.bigint()` decimal nanoseconds from the process-wide monotonic clock shared by worker threads. Small negative scheduling lateness can reflect early timer dispatch and is retained. Driver scheduling lag and driver-to-main observation lag have separate distributions. Probe transport overhead is included; this is not a pure event-loop-only latency claim.

The independent gateway server advertises 100 ms heartbeats and records actual runtime heartbeat frames, acknowledging them normally. The report separates whole-scenario observations from `load-start` to held-release and shutdown-to-join windows. Load-window heartbeat progress is structurally checked. Aggregate operation/probe distributions include setup unless a specific window/role is selected; they must not be described as exclusively loaded-runtime latency.

The leaf callbacks record actual invocation, cancellation notification and actual return. Callback return is only a synthetic leaf settlement, not proof of an external effect or successful wire delivery. Root join and singleton release are independent lifecycle observations. Existing `ownedWorkerUsage()` is sampled on main-thread probe receipt; sampled maxima are never presented as exact native worker peaks or submission counts. Internal connection/dispatcher queues, internal retained bytes, heap/RSS, durable acceptance and real provider outcomes remain unobserved. `peakInjectedBytesAwaitingWireResult` is external offered load awaiting a result and can exceed admission limits; it is not retained runtime memory.

## Reproduction and private evidence

From the repository root:

    .runtime/node24/node_modules/node-linux-x64/bin/node --no-strip-types tools/run-runtime-measurement.mjs

Use `--compile-only` to prepare a separate emitted profile without executing tests. The tracked tool creates a new ignored `.runtime/runtime-measurement-917-*` directory, constructs a private explicit compiler file list from the three named roots and their static imports/literal worker URLs, rejects excluded paths before reading them, and verifies that the compiler's actual source list equals the selected graph. It does not enumerate the test tree or run `build:test`, broad typecheck, a full-suite command, native-read 913, reserved Windows paths, or the protected test. Pinned TypeScript 7.0.2 and Node 24.21.0 are checked. Source, emitted-module and tool hashes bind the profile; emitted JavaScript and native workers execute with `--no-strip-types`.

The tool first runs the deterministic recorder tests, then the bounded scenarios if accounting succeeds. It returns nonzero for any failed scenario. The private directory contains the exact compiler manifest/config, TAP output, run receipt and structured measurement JSON. Raw runtime logs stay private. Only a reviewed, bounded JSON summary with synthetic identifiers and safe error-class names is suitable for publication.

The recorder tests cover UTF-8 identity, large IDs, error-inclusive latency samples, missing results, cancellation versus late actual settlement, duplicate/malformed events, chronology, independent probe identity and send callback consistency. The summary never changes failed or missing outcomes into successes.

## Recorded result and failure boundary

The [bounded JSON evidence summary](../test/fixtures/runtime-measurement-917-summary.json) preserves the final independent run. Strict selected-graph compilation completed, all **8 deterministic accounting tests passed**, and **2 of 3 bounded scenarios completed their structural checks**. Count-saturation recovery failed; the tool correctly returned exit 1. All three roots joined with no retained ownership. These results are scoped and are not a full-suite PASS.

The frozen profile is `0e64a64e06de8ca328ccc1e49ae0373a77d271b37804cd3dcd72e5d7272ae13d`; selected source graph `a17c3d8b49df7313ea3bf4a06130766776e58460375d35b333ece44cde348b27`; emitted graph `01e6338cf43d45fa12eb59f626478a8e91a8e7b322c9203d3b37ff391a66c7b9`. The full private structured report SHA-256 is `65bd5fa6d652176456e5e4e067ffb8a5a7d3c81ca3fece64ac8f1037b1ca75fd`. The summary retains every operation and outcome, with a declared bounded selection of probe records and distributions over all observations. The instrumented count-saturation experiment observes an exact original-ID refusal while four leaves remain held. After release all four synthetic leaves settle, but their wire results and the twelve queued candidates' results remain absent. The existing managed disconnected callback reports `OwnedWorkerBusyError`; cleanup joins and the singleton is released. No queued candidate enters the synthetic leaf.

Read-only code inspection identifies a shared native-codec boundary consistent with that observation: `native-decode.ts` has one module-level `OwnedWorkerSlot`; the dispatcher's codec lock serializes mutation-cache work only inside that dispatcher, while the command loop independently serializes outgoing results using the same native slot. The safe callback confirms the error class, but does not identify the exact competing call-site pair or prove a full causal trace. Production correction is a separate reviewed slice.

An initial development measurement also observed the count recovery failure. A subsequent diagnostic run stopped on a harness bug that misclassified successful `null` send callbacks; that bug was corrected before final verification. Both development outcomes remain recorded in the private evidence; they are not silently counted as successful runtime experiments.

These scenarios do not close all-lane saturation/fairness, mirror serialization, repeated timeouts, expired queued work, unreclaimed native workers, crash reconciliation, native single-owner cutover, protected handoff, real remote backends, Windows qualification, G7 or the remaining [migration completion gates](MIGRATION_COMPLETION_GATES_20261015.md).
