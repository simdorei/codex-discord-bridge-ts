# File-backed legacy-v1 import profile

This test-only profile combines a literal frozen Rust v1 store, the real TypeScript `openInitialized` migration/backup path, closed-handle reopen, and typed public queue/cursor/processed-message consumers. It does not establish all of G6 or release readiness.

## Source and fixture

The 11 literal `V1_SCHEMA` statements come from `simdorei/codex-discord-remote-rust` commit `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`, `crates/cdr-store/src/schema.rs` blob `96486dcb2414aee2feba67ce59da923bf494ebd4`. The bounded JSON summary records the fixed queue/quarantine and cursor-reader source blobs, exact synthetic inputs, source hashes, expanded compiler/runtime argv, and result status.

`test/store/legacy-import-profile.test.ts` creates one owned `realpath(tmpdir())/cdr-g6-legacy-import-*` directory and a UTF-8, DELETE-journal `legacy.sqlite`. It uses the source literal rather than the TypeScript v1 migration to seed nine tables/two indexes, version 1, four queue jobs, four processed markers, and one cursor. No operational database, credential, log, or rollout file is read.

The jobs use Pending/Starting/Running/Quarantined source-valid encodings. Quarantine retains raw `running`, `cdr-quarantined:turn-held`, and `[cdr-rust:app-server-fork-quarantine:v1] process died`. The existing schema-assembly historical fixture with raw `queued` is intentionally unchanged: it is not a valid typed queue-consumer fixture and is not the oracle here.

The fixed IDs and cursor are bigint values above 2^53. The seed preserves UTF-8 Korean/emoji text, NULL turn IDs, boolean flags, fractional timestamps, and baseline JSON. Legacy cursor context is absent as a column, not an empty string. Exact values are fixed in the test and JSON summary.

## Frozen workload and acceptance

- One database, four jobs, four markers, one cursor, one migration, one pre-upgrade backup.
- Two explicit `openInitialized` calls, plus 13 public consumer calls that each internally open initialized state: 15 initialization-capable opens total. Separately, one raw seed connection and one raw read-only backup connection.
- Public calls: `list` once, `listFiltered` twice (target/generation 0 matches all four; generation 1 matches none), `isProcessedMessage` five times (four existing, one absent), `getMirrorOffset` twice, `getMirrorCursorTurn` twice, and matching-path `getOrInitMirrorCursor` once.
- Close the seed before migration; close the migrated handle before every public consumer. The second explicit initialization brackets all public calls with unchanged row and catalog snapshots.
- Verify version 2, current extensions, integrity, every original queue field and UTF-8 byte value, exact typed states/IDs, `app_server_generation=0`, `goal_waiting=0`, and NULL execution/observation generations. NULL is retained historical evidence and grants no new ownership.
- Verify exactly one backup with version 1, identical original catalog/rows, all six unseeded v1 tables empty, and exact original queue/cursor column lists. These lists exclude all newly added columns.
- Matching-path cursor probe proposes initial `0n` and timestamp `1712000001.875`; it must retain `9007199254740993n`, timestamp `1712000000.875`, and NULL context. Final reopen changes neither the migrated snapshots nor the backup list.

## Execution boundary

Pinned Node 24.21.0, TypeScript 7.0.2, SQLite 3.53.4, Linux x64. The existing driver's 5000 ms busy timeout is unchanged. This profile is correctness evidence, not a timing or contention budget measurement.

The guarded graph is 29 TypeScript files: this one new test and 28 production dependencies. The JSON summary includes every path/hash and exact nonempty argv. Both compiler calls use `--ignoreConfig` and explicit source files; no broad build or test discovery runs. The selected compile and production-only compile must report the exact admitted non-package files. Their 28 production JavaScript outputs must be byte-identical before the exact single-file test command runs. Subprocesses fail fast; failure does not select an alternate graph or change acceptance.

The guard rejects protected paths before content reads or import traversal, including every remote-agent path (therefore the native-read graph and redaction test), the unrelated cursor-handoff-crash profile, and Windows-native trees. None is compiled or run. Source/provenance/argv are reviewed and frozen before execution.

## Result and limits

Status: bounded profile passed, independently repeated. Author and reviewer each passed 1/1, with zero failures, cancellations, skips, or todos. The exact selected compile listed 29 project files (207 including library declarations); the production-only compile listed 28 (206 total). All 28 production JavaScript outputs were byte-identical. Both compiler graphs were audited before the first test run.

The literal fixture, source graph, exact argv and assertions were independently approved before execution. The emitted graph was separately reviewed before the author run and rechecked before the reviewer run. Test/source/manifest/runner bytes and acceptance remained unchanged; only this result record and the JSON summary were updated after execution. Emitted graph SHA-256: `914483d94e59b352f688e889b0034096f80917b5ca18a2722892fcddf966c026`.

This is a synthetic, source-fixed TypeScript integration profile. No Rust binary ran, no native Windows claim is made, and no production file is changed. No enqueue, start, recovery, external effect, fabricated ingress/claims, or successful delivery is exercised or inferred. The result does not close all G6 work or authorize deployment.
