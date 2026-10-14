# Bounded native runner display

This change isolates display-only runner inspection. It is not a performance,
24-hour operation, rollout, or deployment PASS. The reviewed requirements remain
`migration/rebuild-20261010/requirements/ts-runtime-parity-pro-reviewed-20261007.md`.

## Ownership and routing

`BasicActionDispatcher` owns one `RunnerInspection`, which owns one pinned
`NativeRunnerInspectionReader`. `SavedRequest` and `Runners` share that reader.
Its fixed operations are `Detail`, `Summary`, `TargetCounts`, and `Global`.
A local `OwnedWorkerSlot('Background')` allows one native operation and no queued
requests. It participates in the existing process-wide Background limit of 3;
inspection never consumes the reserved Control lane. There is no retry or
synchronous fallback. Compatibility entry points use the same native profile.

The native worker performs SQLite reads, full record decoding, JSON decoding,
field-name redaction, and display formatting. No original payload crosses back
to the main thread. Acknowledgements bind the request ID, pinned path, operation,
channel, user, request ID/target, and captured target-display context. Unexpected
fields, incorrect binding, invalid result text, and over-budget results fail.

Selection, resident connection generation, and completion evidence checks stay
in their existing native-backed production routes. Counts provide no permission
to execute, cancel, retry, release, delete, or infer remote idleness. Unknown
resident state remains unknown and triggers no RPC.

## Fixed inspection profile

The following are implementation safety bounds fixed before boundary testing,
not throughput or Rust-relative latency acceptance criteria:

- 10,000 rows cumulatively across a global read's queue, delivery, intake, and
  referenced execution-hold rows
- Up to 20 saved-summary records, selected by the original owner/channel SQL,
  held OR completed with unconfirmed notification, ordered `created_at DESC,
  ingress_id LIMIT 20`
- 16 KiB UTF-8 per request identifier or target-display context field
- 32 KiB UTF-8 captured database path
- 128 KiB serialized request boundary
- Acknowledgement serialized-byte cap of 6 MiB + 129 KiB, allowing worst-case
  escaping plus the bound request and envelope; actual display text remains 1 MiB
- 1 MiB per SQL record; 4 MiB cumulative SQL read charge
- 1 MiB UTF-8 output per section and complete combined `Runners` display
- A separate catalog preflight with the same row/record/cumulative bounds before
  current schema validation
- Default caller deadline 6,000 ms; supported caller range 1–10,000 ms
- Existing-only read-only SQLite profile with a 100 ms busy timeout

SQL preflight returns fixed-size counts, maxima, and byte charges before native
row materialization. It rejects invalid storage classes, including BLOB/text
values in numeric columns, and checks record and cumulative charges before
calling full legacy decoders. UTF-8 text is charged by stored bytes; UTF-16 text
is conservatively charged at twice its stored bytes, bounding UTF-8 expansion.
Numeric values cost eight bytes and NULL costs zero. This is a conservative data
charge, not a heap allocation measurement. The schema check, data preflight,
and row decode share one deferred read snapshot. Fixed data sources must be ordinary
main-schema tables; views, virtual tables, and shadow tables are rejected before
preflight. No initialization, migration,
repair, write transaction, or database creation occurs.

Pretty formatting streams escaped string fragments and indentation into a
bounded accumulator. It does not allocate the full compact or pretty payload
before checking the cap. Combined output is checked before concatenation.
Overflow and malformed data fail the whole operation, never return truncated
or misleading partial counts.

## Preserved distinctions

- Detail owner/channel SQL filtering occurs before payload decoding or its
  byte checks. Foreign malformed or oversized payloads remain absent.
- Summary still fully decodes authorized payload and outcome records even
  though it displays only status fields.
- Only the established credential field names are removed from detail output.
  Literal prompt contents, Unicode, and exact bigint values remain intact.
- Global queue decoding rejects literal `state='quarantined'`; target counts
  continue accepting that literal and preserve their original SQL NULL rules.
- Global source ordering, jobs-before-intakes hold ordering and de-duplication,
  receipt predicates, and malformed-record failures remain.
- `SavedRequest` result dispatch and exact-chunk message delivery are unchanged.

## Deadline and evidence limits

Timeout or abort withdraws caller interest but does not terminate SQLite. The
reader awaits actual worker exit before returning and releasing capacity; late
success cannot replace cancellation/deadline failure. The SQL row/result bounds
do not bound SQLite scanning, sorting, query planning, filesystem blocking, or
its internal heap. A worker blocked below SQLite can therefore outlive the
caller deadline while retaining its slot. No timeout is represented as proof
of native termination. Pinned path spelling preserves native symlink/parent
traversal; it is not a secure inode identity.

Validation uses temporary fixture databases and emitted JavaScript under pinned
Node 24.21.0, bundled `node:sqlite` / SQLite 3.53.4, with `--no-strip-types`.
The connection options are `readOnly: true`, `timeout: 100`, and
`enableForeignKeyConstraints: false`; no journal or synchronous setting is changed.
Focused correctness, lifecycle, and
nonblocking-lock checks are distinct from comparative performance acceptance.
No production database, credentials, bot, deployment, or protected redaction
fixture is needed by this change.
