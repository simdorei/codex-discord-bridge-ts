# Recovered implementation instructions and authority gap

Recorded 2026-10-10, following the user's request to verify preservation after the original workspace became unavailable.

## Requirements explicitly retained in the conversation

1. Continue the TypeScript migration; inspect the actual remote Git version and include later Rust stabilization changes.
2. Centralize thread state reads and writes behind one access boundary.
3. Centralize error handling; feature code should expose typed error kinds instead of independently redesigning each error path.
4. Keep restart decisions in TypeScript; platform scripts should remain thin.
5. Define Discord/Codex boundary types before porting their implementations.
6. Preserve existing behavior, with tests emphasizing thread isolation, ownership and restart scenarios.
7. After the first implementation, apply the separately supplied Pro-reviewed runtime parity specification and additional Rust changes under deployment review.
8. Perform the implementation and code review directly, without delegating code review to Codex application threads. Report actual progress approximately every five minutes in the existing Slack thread.
9. Do not equate a local test count with real Codex/Discord operational qualification, Windows qualification, or production readiness.

## Specification attachment: content still unavailable

Filename: `ts-runtime-parity-pro-reviewed-20261007.md` (19,379 bytes).
The original message identifies Pro document/plan review `TS-RUNTIME-PARITY-20261007-R2` and explicitly says it is not TS implementation, QA, performance, operations or deployment PASS.
On 2026-10-10 its metadata was located, but whole-file retrieval was denied with a Library selected-folder scope error. Reattachment was requested. No alternate route was used to bypass that restriction.
This record is not a reconstruction of the missing document's full text, and no full-spec compliance claim is made.

## Git observations and mandatory delta review

- TS main remains `47d0f7f9a3c75a6ec94b38833cd1992740efaeb3`.
- Rebuild source/test preservation is on `sss/async-admission-cloud`, draft PR #1; no main merge or deployment is authorized by this record.
- Original pinned Rust authority: `4e213aa69dc89bed1552d8b83e12471d7664b7ae`.
- `release/stabilization-held-20261002` still points to that authority.
- Latest Rust main checked at 2026-10-10 14:54 UTC: `ed47c482420631447f0a38ef55a8d29acc1f6f6a`.
- GitHub comparison: 29 commits ahead, zero behind. This is a delta inventory, not proof that those changes have been implemented in TS.

Priority delta areas: channel-scoped final head revalidation; guarded single-transaction retirement of already-confirmed finals and concurrent cleanup fallback; complete/current Codex installation discovery; process identity timestamps and fast-exit custody; owned Unix process-group cancellation; platform-specific fixtures and build/CI contracts.

Freeze full source and relevant dependencies before implementing each delta. Keep the base authority and supplemental revision explicit in each checkpoint. Do not silently substitute a newer source while claiming old-source byte parity.

## Recovery limitation

The original workspace has not been recovered. Current work is reimplementation from the previously preserved remote checkpoint. Raw compressed test logs remain local pending separate sharing approval; source, tests and bounded verification summaries are being preserved remotely.

## Attachment recovered at 2026-10-10 15:02 UTC

The user reattached the document in the same Slack thread. Its full 19,379 bytes are now preserved locally at `requirements/ts-runtime-parity-pro-reviewed-20261007.md`. File SHA256: `a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72`. The body between the explicit markers, normalized by trimming outer whitespace and appending LF, matches the declared approved body SHA256 `b38ec59008b6a98955ca86b0e13034d05eda3b045152e8df1fa235e02c06f22a`. The earlier access failure above is historical; this retrieval used the new user attachment, not a bypass of Library restrictions.

The full A–G contract is an implementation/verification requirement, not a current PASS. In particular DatabaseSync isolation and predefined numerical G acceptance criteria remain incomplete.

## New user-reported stale-stop defect

On 2026-10-10 15:01 UTC the user reported that any historical async-question obligation causes all old unresolved stop requests in the thread to be reevaluated, without distinguishing their jobs. Required correction: exclude an old stop from admission blocking only on evidence of a separate request in the same thread that started later and completed normally. Age alone, a question ledger row, an ordinary acknowledgement, missing history, failed/interrupted completion or another thread are insufficient. Do not delete old ingress evidence or replay the stop. Identify and test the exact durable start/completion/ownership evidence before enabling the exception. Latest Rust main still contains the broad historical predicate at the time checked. Status: confirmed predicate, fix pending.
