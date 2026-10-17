# Native mirror-policy fixed transport extraction

2026-10-16 — runtime-unverified WIP. The frozen source graph has passed two
compile-only checks; application code and tests have not been executed.
No test PASS, operational activation, migration completion or retry approval is
claimed. The prior v4 descendant-exit uncertainty and native execution hold remain;
956 retry approval is still pending.

## Scope and preserved behavior

The installed owner in `src/runtime/discord-runtime/native-mirror-policy.ts` now
calls the fixed `native-mirror-policy-transport.ts` submission. The original
module-global Background `OwnedWorkerSlot` moves to that transport exactly once.
The unchanged shared Background capacity is three; the local slot permits one
active worker. There is no queue, cache, retry, second slot, endpoint, broker,
public dependency injection, selectable worker URL or new wire protocol.

The owner still synchronously checks pre-abort, captures the pinned path then
frozen scalar limits, and probes the original private policy receiver through
`InteractionAccessPolicy.prototype.withMirroredChannelIds.call(policy, [])`
before native submission. Installation still distinguishes the original database
argument from its resolved path. The transport accepts those captured inputs and
constructs the same five-field worker data for the fixed mirror-policy worker.

Submission immediately captures the original slot's busy state and join Promise
in the existing nested finally, including synchronous construction failure. The
outward transport Promise waits that captured join, not a later slot join. Abort
or timeout does not terminate ordinary DB work or release ownership early. There
is no added classification lock after actual exit. The unchanged worker performs
two separate existing-only bounded reads, union and sorting; this extraction does
not fuse transactions or initialize a missing database.

After successful transport settlement the owner checks the original signal again
before inspecting the raw response. This covers the added async boundary. Failure
paths do not run that success-only abort check. Raw response validation, bigint
range and strict ordering checks, output-count validation, and reconstruction via
the original policy prototype remain in the owner. No stricter exact-property
shape, stale policy fallback, extra ID copy or static-list broadening is added.

## Exact invocation refusal proofs

P0 is the exact slot.run Promise. T is the non-async transport wrapper's exact
returned Promise. R is the internal owner refresh Promise. P is the existing
external owner catch-wrapper Promise. They are distinct identities.

Only the transport's synchronous local-busy observation or successful consumption
of the existing exact slot/P0/error admission-refusal proof can mark its private
invocation origin eligible. A private WeakMap binds the resulting exact error to
T once. Its consumer checks both T and exact error identity and deletes the entry.
An error class, name, cause, copied field or replayed genuine error is insufficient.

A captured join rejection explicitly clears eligibility before propagating the
cleanup error, even if that rejection uses the same object as an earlier capacity
refusal. Original finally rejection precedence is retained; there is no aggregate
or invented successful cleanup. The owner converts only a consumed T proof into
its existing capacity error and retains its original private origin and one-use P
proof. Wrong-Promise and replay protection must be exercised in future tests.

## Retention and limits

Each invocation adds internal async state and references to T, existing captured
path/limits/signal, and exact refusal error metadata. While failure remains
unjoined, the internal submission and captured join remain live. Private WeakMaps
do not add strong roots for dropped Promise keys. No additional cross-thread
serialization or ID array is needed by this extraction.

Existing overlapping policy arrays/Sets, the private-receiver probe, both query
results, spread/union/sort temporaries, worker and main buffered results, and old
and reconstructed policy lifetimes remain. This is not a numeric total heap,
node, byte, RSS, SQLite or allocator budget proof, and does not reuse the 951
adapter ledger.

Installed configuration capture bounds channel and user allowlists to 4096
entries each. Direct InteractionAccessPolicy construction and the direct refresh
API do not independently bound those static allowlists. The installed bound is
not a universal direct-caller or whole-graph bound. Unchanged native limits are
maxRows <= 4096, maxValueBytes <= 4194304 per query, maxOutputIds <= 16384 and
timeoutMs <= 10000; an installed 8192 output limit remains its supplied value.

## Compile-only evidence and remaining qualification

After independent source and graph review, author and independent reviewer each
compiled the same immutable snapshot: 426 selected project sources plus 178
declarations, and separately 422 production project sources plus those 178
declarations. All four compiler processes returned exit 0 with observed process
wait completion and output-stream EOF. The compiler file lists were audited
against the frozen graph. All 422 production JavaScript outputs matched the
selected-build outputs, and the author/reviewer production hash maps matched.
This establishes compile-only graph/parity evidence, not runtime behavior.

The initial preparation incorrectly assumed selected/production counts of
317/313 and failed with KeyError before snapshot creation or compiler execution.
That attempt is retained as a preparation failure, not a failed or successful
compile. The reviewed replacement graph contains 110 additional project sources
relative to checkpoint 956, owing to the policy type and workflow dependency
closure. A new immutable snapshot and runner were used; no application, test or
native fixture code was executed.

Evidence identities (SHA-256):
- Frozen input manifest: 59c7a2de9b3336d82816df9aaec0bf8daf35d185e5e08397c3e2443d10630a06
- Compile-only runner: d17161c7cf0ab76b39ae80e1292426f29bf122d2dd6295429b53f359f94046c5
- Independent result receipt: 0005e12cd9071c0a653c78f32df4b155429f66f72a134f0f654d118259bdb649

Both implementation files remain byte-identical to those independently reviewed
and compiled. This documentation update does not change their behavior. The v4
native execution hold remains; compiler exit receipts do not establish the old
fixture descendants' exit or grant runtime retry approval.

Future runtime qualification must cover the existing
installed-owner suites; real shared-capacity saturation and local busy; exact
T/P proof consumption, wrong Promise and replay; original receiver/path/limits
validation before worker creation; actual exit and captured join on cancellation;
real-exit-to-owner-resume cancellation; worker/read and capacity error precedence;
and join rejection with the same refusal object. Complete two-query result and
immutable-policy semantics must remain unchanged. No persistent-worker relocation,
Windows, root acquisition, descendant cleanup, G7 or full migration gate closes
from this source extraction.
