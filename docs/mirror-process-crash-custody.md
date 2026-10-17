# Mirror process-crash receipt custody

Checkpoint 924 is a test-only, partial G5 experiment on Linux. It kills an actual
owned disposable Node process at three receipt/cursor boundaries and starts a
fresh process against the same temporary files. SQLite, bootstrap, discovery,
native workers, receipt persistence, cursor transactions, and process exits are
real. The transport is a synthetic file handshake with acceptance witnessed by
the surviving parent. No production code or earlier experiment changes.

## Frozen plan

The workload, cut locations, state assertions, and bounds were frozen before
the first execution. The original error-chain expectation omitted an existing
wrapper and failed. That failure and its explicitly approved correction are
recorded below; the corrected exact-chain plan was frozen and independently
reviewed before either accepted execution. A mismatch remains a failed
experiment and never itself authorizes changing deadlines, expected behavior,
production guards, or workload.

Each of three independent fixtures has one SQLite database, one mapped target
and channel, and one append-only rollout. Bootstrap exactly 16 LF-terminated
256-byte JSON records (4,096 bytes), with first/last turn contexts and 14 middle
historical messages. The existing bootstrap reaches revision 1, retains the
final historical turn, retires its startup intent, and sends no historical data.
Append and genuinely deliver one 256-byte seed to offset 4,352/revision 2. Retain
the complete seed receipt and both bound/legacy cursor rows. Append one unique
256-byte target, reaching a 4,608-byte rollout.

There are exactly six children in the successful matrix, sequentially: one crash
child and one restart child per fixture, never more than one live child. Each
child discovers authentic jobs from the real store; every restart poll performs
fresh discovery and observes the rollout through the real bound-poll path.

The crash child's method wrappers forward original receivers, arguments,
responses, and errors. They insert only timing barriers:

1. **intent-before-send:** await real `NativeMirrorReceiptStore.begin`, require
   `New`, and park before returning it to the sender. Native Begin 1, Confirm 0,
   MixedAdvance 0, transport entries 0, external acceptances 0.
2. **external-accept-before-confirm:** finish the real synthetic transport
   handshake after the parent has fsynced and closed its acceptance witness;
   park at confirm-method entry before calling the original confirm. Begin 1,
   native Confirm 0, MixedAdvance 0, transport entries 1, acceptances 1. The exact
   large accepted ID is held by the doomed process and external witness, while
   the local target receipt still has no message ID.
3. **confirm-before-cursor:** await real confirm, require `true`, and park before
   returning to the sender. Begin 1, Confirm 1, MixedAdvance 0, transport entries
   1, acceptances 1. The target row contains the exact accepted decimal ID.

An exact-native-URL observer counts calls to the original `OwnedWorkerSlot.run`
at entry, without rewriting native payloads or results. The complete pre-crash
native map is cursor Read 1, decode 1, ownership 2, receipt plan 1, Begin 1, and
only in case 3 Confirm 1. All five native lanes and active mirror-file reads must
be zero at every barrier. These are between-operation cuts, never crashes inside
a running worker or SQLite transaction.

## Actual process and external acceptance ownership

The parent directly spawns its pinned Node executable with the explicitly
compiled child `.js` entry and `--no-strip-types`. Stdio is ignored. Coordination
uses bounded atomic files in the owned fixture, with no IPC channel, socket,
listener, shell, detached child, process group, or process enumeration.

Each child transport entry is counted before serialization or validation and
publishes a separately numbered request. The parent counts each actual request
before validating it. It never deduplicates bodies or nonces. Unexpected extra
requests fail after being counted. Before returning acceptance, the parent writes
a distinct witness with the request-body SHA-256 and an exact unique decimal ID
above 2^53, fsyncs the file, closes it, atomically publishes it, and fsyncs/closes
the directory. Only then does it publish the response. The restart child does
not consult or import the witness as local receipt authority.

After the barrier, the parent checks durable state, calls `SIGKILL` only on the
exact created `ChildProcess` handle, and requires both real `exit` and `close`
with the expected signal before restarting. A true kill return is not exit
proof. No process-local packet, jobs snapshot, WeakMap entry, or operation ID is
serialized and restored. Current-process packet authenticity is checked only
inside the new process after genuine fresh polling.

## Restart acceptance

For cases 1 and 2, inspect the original database after confirmed process death,
then run two explicit fresh polls. Each requires the exact
`MirrorBatchExecutionError` class caused by exact `DeliveryFailure`, itself
caused by exact `CompletionDeliveryError` with the Unknown-outcome message and
no further cause. The delivery wrapper has part 1, total parts 1, attempts 1,
and its `source` is the identical object as its `cause`. Arbitrary nesting or
a general rejected Promise does not satisfy acceptance. Each has a non-null, newly
factory-authenticated packet whose receipt key/hash match the retained target.
Both polls submit native Begin once and receive `Unknown`; neither submits
Confirm or MixedAdvance or invokes transport. The complete target/seed receipt
rows, bound cursor, legacy cursor, mapping, startup-intent absence, and rollout
identity remain unchanged. Offset remains 4,352/revision 2. This is retained
unknown responsibility: case 1 was unsent, case 2 externally accepted but locally
unknown. Neither is described as recovered delivery.

For case 3, the fresh receipt plan reuses the original confirmed receipt. The
first poll performs no transport, Begin, or Confirm; it submits one MixedAdvance
and reports one satisfied delivery. Exact native map: Read 1, decode 1,
ownership 1, receipt plan 1, MixedAdvance 1. Both cursors reach offset
4,608/revision 3 with the same file generation and an independently calculated
target receipt-set hash. Every receipt column and exact large accepted ID remain
unchanged. The following EOF poll submits only Read 1 and decode 1, sends
nothing, and preserves the entire database snapshot. Fresh packet operation IDs
are not restoration of the dead process's packet.

## Bounds and failure accounting

Native operations: 5,000 ms. Bootstrap: 10,000 ms. Each child barrier or complete
two-poll restart: 15,000 ms. Exact-child termination/join: one nonrenewable
5,000-ms deadline. Whole matrix: 180,000 ms. These are safety guards, not latency
qualification. Read limits are 4,096 bytes, four records and 512 bytes per record;
ownership limits are 32 jobs and 1,048,576 value bytes. Handshake files are capped
at 65,536 bytes, with at most four numbered requests and only one pending request.

Every failure stops dependent work. Cleanup attempts all parent owner closes and
terminates/joins only the exact owned child. A failed termination cannot receive
a new deadline in `finally`. If actual process death is uncertain, the fixture
is retained, no restart is attempted, and the diagnostic retains nonzero process
and fixture cleanup debt. Before removal, the parent's original temporary root
canonical path, direct parent, device/inode, and non-symlink identity are checked.

Diagnostics are emitted after cleanup and include completed case rows,
unfinished counters, fixed failure-stage labels, real exit/close evidence,
pre-crash native/file holdings, healthy restart holdings, parent holdings, and
cleanup debt. They contain no temporary path, raw request/rollout, database dump,
worker payload, exception text, or PID. Killed-process post-death counters are
unobservable and are never reported as zero. Raw compiler/TAP output is private.

## Reproduction and evidence limits

Use pinned Node 24.21.0 from
`.runtime/node24/node_modules/node-linux-x64/bin/node` and TypeScript 7.0.2 from
`node_modules/typescript/bin/tsc`. Compile the two explicit test/child TypeScript
roots plus guarded static dependencies and literal worker URLs to fresh private
output. Guard lexical and canonical paths before every source read. Use strict
ES2023/NodeNext, rewritten JavaScript imports, explicit files, and empty
include/exclude arrays. Verify the actual compiler project-source list exactly
matches the frozen guarded graph before invoking emitted JavaScript with
`--no-strip-types --test --test-concurrency=1` and
`NODE_OPTIONS=--no-strip-types`. There is no source execution fallback.

No broad test profile, content search, protected redaction test, restricted
remote-agent native-read path, or reserved Windows path belongs in this run.
No Git operation, upload, deployment, live database, real bot process, provider
request, listener, or Rust oracle is involved.

This is partial Linux direct-child synthetic between-operation process-crash
custody evidence only. It does not qualify full G5, admission-before-intent,
in-flight provider ambiguity, crash during SQLite commit, lost cursor ACK,
power-loss durability, real-provider exactly-once behavior, Windows/process-tree
ownership, survival of an old owner, Rust equivalence, or deployment readiness.
No gate is promoted.

## Recorded outcome

The first frozen runtime execution is recorded as **FAIL**, caused by an
expectation omission. It incorrectly expected the delivery error as the direct
batch-error cause. Existing `receipt-plan.ts` uses `deliverChunksIndexed`, whose
existing `DeliveryFailure` wrapper supplies the intervening cause. The first
case reached its actual SIGKILL cut, restarted, and observed Begin `Unknown`
with zero transport, Confirm, or MixedAdvance. It then failed the direct-cause
assertion. Both spawned children settled; parent native/file holdings, remaining
fixture directories, and process/fixture cleanup debt were zero. No other case
was reported as completed.

The original frozen sources/plan and failed diagnostic are retained privately.
Failed diagnostic SHA-256:
`7bf2af4ac6b9c610034ac6903e7e928c072fc4813107de3449c6766e1b2e8fcf`.
Original runtime source graph SHA-256:
`814ea522567eeb6447631c8c705e842e29b32dbd1dc721084a9664f689372bf2`.
An explicitly approved, source-corrected plan revision now requires the exact
three-class chain and delivery-wrapper fields described above. The production
code, workload, state assertions, counts, cut placement, and all deadlines are
unchanged. This correction is not a passing result for the original plan.

Before runtime execution, both compilers also rejected two local type-inference
declarations. Two explicit type-only annotations resolved those errors; the
failed compiler receipts remain private. There was no runtime from that compile.

The corrected frozen candidate passed the author execution and a separately
compiled independent execution, without overlapping matrices. Both actual
compiler lists exactly matched the 302-source guarded graph. Their complete
15,900-byte bounded summaries matched byte for byte, including all cuts, exact
error chains, native submissions, real exit/close signals, restart outcomes,
durable-state checks, and cleanup. The verified
[result summary](../test/fixtures/mirror-process-crash-custody-summary.json)
contains three complete cases and six actually settled children, with maximum
one live child, three seed transport attempts, two target transport attempts,
and two external target acceptances. The two unknown cases remain at
4,352/revision 2; confirmed reuse advances once to 4,608/revision 3. Every
restart transport count is zero. Both private fixture parents were empty after
cleanup; there is no outstanding owned-process or fixture cleanup debt.

The [parent test](../test/runtime/session-mirror/process-crash-custody.test.ts)
SHA-256 is
`709d0f41d1a82274fb49d3dd58bf3324510d50458d34e5514bfa394d779c071c`.
The [child](../test/runtime/session-mirror/process-crash-custody-child.ts) SHA-256
is `0dd32819b22ee17bd83ec604891e0456a6d0033840770e02a51ffe25a97863eb`.
Corrected source graph SHA-256:
`ed832baa8b456c9814a6ef5c2c68a1a65dca6e2501a6d7edb7e00798d6bbb557`.
Matching emitted graph SHA-256:
`142d5fe7ab99a9fd7d1f381d40c4bf2ecf642798f1d78bab09f7dbdb9cdb2022`.
Verified summary SHA-256:
`f51e401a38ae91899e0deaebf15c47208ca5b3da4b8123d7fac09455324be5e6`.
