# Preservation status

Unapplied WIP. Focused 512/512, strict TS and build passed. Whole 775-file regression is running; no whole PASS is claimed. Historical pending language below describes the pre-test plan.

# WIP 739: complete NewThreadJournal native boundary

Combines tested existing-store foundation 737 and pure wire codec 738. Adds three operations to the existing fixed native worker (17 total) and three Existing functions to the single state facade (313 total). Original admission/hold/lookup business bodies remain shared. Pure admission capture reuses original validation before native submission. NewThreadJournal captures a three-function port using own-data fields; NewThreadExecutor and RuntimeCommandExecutor pass the same fixed native state. Original WeakMap full-record ownership, context checks, cancellation, clock and public-safe manual hold semantics remain.

Control remains capacity one with no queue; actual native join precedes slot release. A late write may commit and is unavailable, never automatic thread/start permission. Full records use lossless Serde JSON strings, signed i64 values, closed numeric tags, and explicit absent outcome. Complete packet budget remains 16 MiB. Identity-bound replies reject crossed operations/requests and malformed records.

This is an unapplied candidate. Focused and full qualification are pending. Windows/live appserver/Discord/endurance remain unverified. No extra pool or retry, operating deployment or main merge is included.
