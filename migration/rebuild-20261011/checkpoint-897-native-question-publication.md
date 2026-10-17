# Checkpoint 897: native AsyncQuestion publication

Baseline: a90df4ec25c0c88f709ca542fbbf17f1392cb371. No Git writes, publication, deployment, live database access, or protected fixture edits.

## Change
- Added the three exact null-guard receipt profiles: shared item context and question body multipart receipts, and question controls/unsupported diagnostics at chunk zero.
- Added existing-only owner confirmation with the original IMMEDIATE transaction and latched rollback fast path, plus existing-only control receipt binding with the original outer read connection and separate owner-confirm transaction.
- Added a dedicated bounded publication owner capturing the original immutable question before native await. Prepare uses zero-queue Control admission; Bind and Error use the existing finite Control completion FIFO. All operations require an exact original-operation acknowledgement and join actual worker exit.
- Preserved the default compatibility APIs and opted the installed completion pipeline into native publication. The checked question adapter and installed HTTP transport now forward the lane signal. Accepted receipts and final control binding settle independently of cancellation; later body/context chunks stop after cancellation.
- Bound native receipt/error completion writes to one original row/raw-body snapshot and an immutable-field conditional UPDATE. Same-ID replacement cannot receive old control bindings or diagnostics. Historical non-null receipt message text, including 000123 and m, remains valid.
- Registered the new worker in the closed store-authority manifest; no new pool or bypass.

## Verification
- Node 24.21.0, emitted JavaScript only, NODE_OPTIONS=--no-strip-types and explicit --no-strip-types.
- Strict typecheck: pass.
- Production build: pass.
- Focused tests: 51/51 pass.
- Whitespace check: pass.
- Full affected attempt: 590/594 passed across 62 files. Four tests are environment-blocked by Unix-domain socket listen EPERM in discord-runtime/store-authority-profile.test.ts; the same failures are recorded in checkpoint 896. This is not an overall pass.
- Bounded affected matrix: 590/590 passed across 61 files, excluding only the known Unix-socket environment-blocked file. This is scoped verification, not a complete repository suite pass.
- Independent review: 44 tests passed on identical production sources, including additional Bind/Error race interposition. Final closure verified 18/18 hashes, exact changed-file set, and all 936 emitted source files byte-identical between reviewed and final outputs; the sole final test delta (locked accepted-control HTTP lane) independently passed 1/1. No remaining functional findings.

## Important coverage
Actual installed completion factory to native payload/state to real loopback HTTP with the compatibility facade poisoned; multipart byte/hash/nonce parity; shared context deduplication; unsupported controls; partial rejection, unknown hold and 429 retry; bind-only recovery after delivered controls; historical message decoder parity; owner latch/rollback; changed occurrence; exact ACK refusal; accepted cancellation; SQLite-lock responsiveness and actual-exit joining; Control FIFO and zero-queue refusal; subsequent independent question progress; HTTP lane/channel retention while an accepted control receipt is locked.

## Artifacts
- Freeze and emitted snapshot: checkpoint-897-freeze.json
- Source hashes: checkpoint-897-final-hashes.json
- Focused results: checkpoint-897-new-tests.tap / .exit
- Affected matrix: checkpoint-897-affected-files.txt and checkpoint-897-affected.tap / .exit
- Typecheck/build/whitespace: checkpoint-897-*-build*, checkpoint-897-typecheck.*, checkpoint-897-whitespace.*
