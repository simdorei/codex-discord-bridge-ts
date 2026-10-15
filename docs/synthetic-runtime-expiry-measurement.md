# Bounded synthetic expired-queue recovery (919)

This test-only checkpoint adds one deterministic expired-queue experiment to the installed synthetic root, using the unchanged measurement recorder and independent driver from [917](synthetic-runtime-measurement.md) and the codec ownership correction from [918](remote-native-codec-ownership.md). It changes no production source, admission bound, retry policy or authority. Original 917 files and 918 evidence remain unchanged.

The result is **scoped synthetic structural evidence**, not G4 closure, real-time repeated-timeout qualification, a performance PASS, a matched Rust comparison, full-suite acceptance or operational readiness. The dispatcher UTC and request-budget monotonic clocks are injected and frozen between explicit advances. Real measurement, heartbeat, probe and safety-guard clocks are unchanged.

## Predeclared workload

Before the first runtime execution, the complete set of 60 unique original IDs, wire payload hashes and fixed deadlines was declared. Every ID contains the large decimal string `9007199254740993` and Unicode `é🧪`; IDs remain strings throughout transport, accounting and results. No expired request is replayed or given a new deadline.

One prepared synthetic root owns four restored project bindings. Binding expiry is 300 seconds UTC; session setup, held writes, overflow candidates and fresh recovery probes have deadlines of 200 seconds UTC. Initial dispatcher UTC is 100 seconds, nanosecond zero, with injected monotonic time 100,000,000,000 ns.

The boundary pair runs first:

- Deadline exactly equal to injected UTC: exact original-ID `operation_error/request_expired`, with no backend invocation.
- Deadline one nanosecond later: exact original-ID `write_file_result`, while injected UTC remains frozen. The synthetic leaf explicitly reads its budget against the injected monotonic clock on entry and again before returning; it never defaults to real `hrtime` for this check.

Three successive waves use the same root and sessions. Each wave:

1. Holds four valid write leaves, one per project, and observes all four backend starts.
2. Sends twelve unique queued candidates, then one overflow candidate. Their total offered wire bytes, including held and overflow commands, remain below the unchanged 4,194,304-byte cap. The installed connection limits remain four active and sixteen total retained operations.
3. Observes the overflow's exact original-ID `operation_error/bridge_busy`. All sixteen held/queued sends must already have injection and successful callback observations before that result. All four leaves remain unsettled and uncancelled; no queued candidate has a result or backend start. Actual independent gateway heartbeats and main-thread probe observations must occur while leaves are held.
4. Only then advances injected UTC and budget monotonic time together, to the queued deadline plus one nanosecond: 110.000000001, 120.000000001, then 130.000000001 seconds. The currently held operations and session/binding deadlines stay valid. No wall-clock sleep makes a request expire.
5. Releases the four leaves and requires four successful writes, twelve exact-ID `request_expired` results and the original overflow refusal. Expired result timestamps must follow both clock advance and held release, and queued commands must never start a backend leaf.
6. Sends a new valid unique probe and requires its successful write result before the next wave, or before shutdown after the last wave.

The complete expected result is 60 declared/injected/wire-result records: four session results, sixteen write results (twelve held, three recovery probes and the one-nanosecond boundary probe), 37 expiry errors (36 queued plus exact equality), and three busy refusals. Exactly sixteen write leaves start and settle, with zero cancellation, expired backend starts, missing results or disconnects. Shutdown must join, release the synthetic singleton once, remove its identity marker and leave every native lane at zero held workers.

The 15,000 ms per-condition guard and 60,000 ms test guard terminate faulty tests; neither is a latency acceptance threshold. Counts, deadlines and guards were not relaxed after observation.

## What is measured and what is inferred

The independent worker owns loopback remote/gateway transports and uses anchored 25 ms probes plus 100 ms gateway heartbeats. Input send invocation, successful send callback, received wire result, backend start/settlement, clock transition, root join and singleton release are distinct observations. Error responses contribute to the same inject-to-result distributions as successful responses. All 60 operation identities, wire UTF-8 byte counts/hashes and observed outcomes are retained in the bounded summary. Whole-scenario probe/heartbeat lists are explicitly sampled, while distributions use every observed sample and per-wave held-window observations are retained.

The evidence for queue admission is **source-supported inference**, not a direct internal queue gauge: the installed command loop processes its ordered input, all four active leaves remain held, all twelve additional inputs have completed sends, and the following original ID is refused at the unchanged count bound. The test does not observe private queue occupancy or exact internal retained bytes. Offered wire bytes awaiting results remain an external measure, not heap/RSS or internal memory. Sampled native gauges remain samples, not exact peaks or submission totals.

The recorder's inherited `loadUntilHeldRelease` window covers the first wave only; each of the three `waves[].heldWindow` records supplies its own heartbeat and probe evidence. No timing distribution qualifies real-time expiry, runtime throughput or an SLA.

The boundary remains temporary SQLite, a mock resident process, independent loopback transports, emitted native codec workers and the existing synthetic singleton seam. Native UNIX singleton exclusion and its known bind EPERM case are not exercised or retried; there is no TCP replacement. Real providers, operational databases, protected durable handoff and restricted native-read 913 remain outside the graph. 893 remains inactive. Reserved Windows paths and all-lane/G7/full migration qualification remain excluded.

## Reproduction and selected profile

From the repository root:

    NODE_OPTIONS=--no-strip-types .runtime/node24/node_modules/node-linux-x64/bin/node --no-strip-types tools/run-runtime-expiry-measurement.mjs

`--compile-only` prepares a separate emitted profile without executing tests. The runner checks pinned Node 24.21.0 and TypeScript 7.0.2. Its only roots are:

- `test/helpers/runtime-measurement-driver.ts`
- `test/runtime/discord-runtime/runtime-measurement-accounting.test.ts`
- `test/runtime/discord-runtime/synthetic-runtime-expiry-measurement.test.ts`

It follows only static relative imports and literal native-worker URLs from selected files, rejects protected/restricted/reserved paths before reading, constructs a private explicit compiler file list, and verifies the compiler's actual project-source list against that graph. It does not invoke broad typecheck, `build:test` or a full suite. Both emitted JavaScript and native workers run with `--no-strip-types`.

The frozen executable profile contains 913 selected/emitted modules:

- Source graph: `4bf3bd03a5e46d8914bbbc6ecf8fb46aafce2b577e89a3700dcf8b064f671ba9`
- Emitted graph: `c7e5347a5c1d41cc99f73ad1e57c9ac0af307b641154ce46b69da24afbe656df`
- Profile: `ef1f58748ef54bbe9bd622c0a2401c55f69ec452f3801d9d09da93effa7e346e`
- Runner: `6d30406c369adfdaf30799e893af2de7fcbf21cffd6f06d61d8c4491739a5d83`
- Test: `0ef5d1a1a8b36cfc644d74bd4a5f86e60e123844dc1a7bc3a8705f162e8a2371`

## Recorded outcome

The [bounded 919 JSON evidence](../test/fixtures/runtime-measurement-919-summary.json) preserves the first runtime execution of the frozen candidate. Strict selected compilation completed, all **8 unchanged accounting tests and both new tests passed**, and all **three waves completed** their predeclared structural checks. All 60 wire results were observed with the exact expected types and original IDs. There were no expired backend starts, cancellations, disconnects, missing results or accounting issues. The root joined, released the synthetic singleton exactly once, removed the marker and left all native lanes at zero held workers.

The author run observed 602 independent probes sent, observed and acknowledged. Its held-wave windows contained 9/11/12 gateway heartbeats and 39/40/47 observed probes. These counts demonstrate observed progress within those windows; they are not a responsiveness guarantee. The full private structured report hash is `1607e4fd73c500986f2d6a846d8b9e23c37da37b510d87ea5287cfdc86e4a38e`.

One earlier compile-only development attempt failed on harness type annotations, which were corrected before runtime execution. A subsequent compile-only run passed. Neither attempt executed the workload or changed its counts, deadlines or guards. Raw compiler/runtime logs and full private manifests remain untracked and unpublished.

An independent final compile and rerun used the same unchanged source/emitted/profile hashes. It also passed all 8 accounting and both expiry tests, with all three waves and exact 60-result contract intact, no missing results or accounting issues, joined shutdown and zero final native holdings. The independent full structured report hash is `430a8b7e4671ee8a9a2abe6129e0e98083e3b866cd0d4230081a068d52fff20d`. It observed 592 probes sent/observed/acknowledged and held-window heartbeat counts 11/11/10 with probe counts 44/44/40. Detailed operation rows and timing distributions in the bounded summary are from the author run only; independent counts and lifecycle outcomes are a separate record, never mixed into those timing samples.

These are two successful executions of the same frozen synthetic workload, not a repeated-real-time-timeout or reliability qualification. Remaining [migration completion gates](MIGRATION_COMPLETION_GATES_20261015.md) are unchanged.
