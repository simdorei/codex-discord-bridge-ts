# Fixed resident direct-child closure diagnostic

Status: SOURCE-ONLY WIP, 2026-10-16. NOT COMPILED / NOT RUN / NOT PASS.

This additive diagnostic implements the bounded v2 design with contract SHA-256
48f171476e41b49b9f182418c4be4e444474f5d1af0a64a5d2fe38f05ca40262.
The earlier v4 run remains UNKNOWN and the native execution hold is unchanged.
Neither this patch nor a later passing test can reconstruct that run's lost child
identity or qualify its cleanup.

## Meaning and authority

The normal-component snapshot adds `directChildClosure`. It is a scalar report
from the original fixed Worker, not an independent main-side OS observation.

- `not-started`: the fixed composition's start was never invoked and the terminal
  failure latch prevents it from subsequently starting.
- `confirmed`: the initial start returned its original resident, no
  replacement-capable fixture was entered, and that resident's one original
  terminal disposal fulfilled. This concerns one initial direct responder child
  and its owned resources only. It does not certify descendants or other runs.
- `unknown`: all remaining cases, including pending/rejected startup or disposal,
  any normal-replacement invocation, missing/corrupt reports, or death without an
  accepted terminal report. Unknown does not imply either alive or exited.

The fixed composition currently installs no automatic restart supervisor. Adding
one, or another replacement route, invalidates the narrow positive predicate
until separately reviewed. Normal-replacement remains unknown even after success:
a replacement construction can fail before lifecycle session registration, and
later disposal fulfillment is insufficient to certify that attempted child.

## Ownership and ordering

The worker records entry into startup immediately after its final failed-phase
check, retains the original start promise before yielding, and shares exactly one
disposal promise across normal close, failure, and late startup completion. A
rejected disposal is never retried. Its explicit rejected outcome retains thrown
undefined. The first failure phase/category/fixture step is snapshotted before
cleanup; later failures cannot overwrite it. Protocol corruption quarantines
immediately; ordinary lifecycle failure first attempts original disposal.
Pending startup/disposal cannot emit a premature closure certificate.

Main strictly captures exact own fields and enum values and separately retains
terminal-kind and a monotonic report-corruption flag. A first valid failure report
may add diagnostics after ordinary timeout quarantine; it cannot reopen admissions
or resolve close successfully. Duplicate, malformed, conflicting, wrong-phase, or
impossible positive reports permanently clear the diagnostic to unknown. No later
frame can promote it. Main rejects confirmed for normal-replacement independently.

Normal release still requires actual Worker exit, normal disposed report, original
native service joins/releasability, and mutation state J, plus the new no-corruption
and disposed-terminal conditions. Failure diagnostics never call release, notify
normal disposal, finish mutation, or settle custody/idle. Failed paths retain root
debt and registration accounting. The new diagnostic is not read by either
existing test-directory deletion predicate. Join semantics are unchanged.

Only callbacks already processed before the release decision can affect that
decision. This patch does not claim that a genuinely later callback revokes a
completed release. Stronger event ordering/containment remains separate work.

## Source assertions and remaining qualification

Existing targeted test source now checks the three exact labels, initial unknown,
normal nonreplacement confirmed, successful normal-replacement unknown, and
pre-start duplicate-bootstrap not-started while quarantine/root debt remain.
Existing protocol-only witnesses still state responder closure unconfirmed and
cleanup/component qualification false; this diagnostic does not upgrade them.
The mandatory aggregate cleanup qualification gate remains unchanged.

These assertions have NOT run. No compiler, test runner, native process, process
control, directory cleanup, or deployment was invoked for this increment.

Future separately authorized qualification still needs pending startup failure,
synchronous/asynchronous startup rejection, disposal rejection including undefined,
protocol failure racing normal disposal, late valid failure after main quarantine,
identical/conflicting terminal frames, malformed/getter/proxy/extra-key/version
frames, corrupt-then-valid frames, missing reports, and actual replacement failure
before lifecycle registration. Hung/abrupt-death cases require independently
reviewed external containment before execution. Neither requester exit nor an
unrelated process listing proves former responder/descendant closure.

No lower-level child ownership, production DB authority, final synchronous
validation-to-write order, service protocol, mutation outcome, public DI, root
qualification, Windows qualification, or migration-completion claim changes.
