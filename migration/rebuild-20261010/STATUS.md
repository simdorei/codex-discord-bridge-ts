# Reimplementation after executor disconnection

The original 8,183-test workspace remains inaccessible. Nothing in this directory claims its recovery.

- Remote baseline: `371018cb132b2578e0aa74e5db85d0debec04ccb`.
- Rust authority: `4e213aa69dc89bed1552d8b83e12471d7664b7ae`.
- Fresh baseline: Node 24.21.0; 5,086 tests PASS, zero failed/cancelled/skipped; strict TypeScript exit 0.
- Baseline logs: `.runtime/rebuild-baseline/`.
- Reimplementation 277: dedicated recovery publication intent sink. Nine new focused tests PASS; strict TypeScript exit 0; full suite 5,095 PASS, zero failed/cancelled/skipped.
- Current evidence: `.runtime/rebuild-277-publication/`.

The sink keeps maintenance admission alive, checks canonical custody DB identity, acquires the shared target mutex with a two-second deadline, rechecks delivered and durable ingress identity, and records immutable consent. It never starts or replays a request. Dispatcher integration, other missing runtime modules, platform qualification and full migration remain incomplete.

The prior checkpoint 633 full-suite outcome remains UNKNOWN. The older 8,183 count is historical, not the current recovered checkout count. Original-workspace recovery request remains separate from code reimplementation.

## Reimplementation 278

Abandonment proposal/receipt codecs preserve typed struct order, i64/u64 bits, strict unknown/duplicate field rejection and unit enum decoding. Six new focused tests PASS; full 5,101 PASS, no failures/cancellations/skips; strict TS exit 0. Raw 277/278 verification logs are retained as gzip files under `evidence/`. No abandonment write or runtime integration is claimed.

## Reimplementation 279

Borrowed abandonment identity checks now read actual persisted source commands and decision clicks, compare exact actor/runtime/delivery identity, preserve historical-vs-fresh custody rules, and reject cross-proposal reuse. Eleven focused native SQLite tests PASS; full 5,112 PASS, zero failed/cancelled/skipped; strict TS exit 0. Raw logs and source hashes retained. No abandonment write or runtime integration is claimed.

## Reimplementation 280

Private abandonment snapshot now checks owned, held, unstarted Pending state; exact mapping; absence of unresolved mutation/cancellation; 16 source query pages; runtime/source identity; canonical database identity; and 393,216-byte/128-row limits. Publication and abandonment share one bounded typed SQLite evidence reader. Eleven new full-schema native SQLite tests plus eleven unchanged publication regressions PASS; full 5,123 PASS with zero failures/cancellations/skips; strict TS exit 0. No proposal/decision writer, runtime integration, fresh Rust differential or Windows qualification is claimed.
