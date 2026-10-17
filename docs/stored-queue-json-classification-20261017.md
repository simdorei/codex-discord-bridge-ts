# Stored queue JSON classification — checkpoint 970 WIP

## Active source change

The existing queue-row baseline decoder now reports a distinct `StoreJsonError` with `kind: 'Json'` when parsing `baseline_turn_ids` fails. It previously converted those failures into `StoreIntegrityError`. This corrects the source-category mismatch recorded in checkpoint 968; the earlier checkpoint remains historical evidence of its then-current behavior.

Only the parse catch in `src/store/queue-read.ts` changes. It still uses the existing `parseSerdeValue` implementation and validates the queue state before parsing. Successful non-array JSON becomes an empty baseline vector. Mixed arrays keep strings and serialize other JSON values through the same canonical serializer. No stricter array shape, new parser, new size limit, different SQL, filtered substitute or changed row ordering is introduced.

Malformed syntax and unrepresentable numeric values, including overflowing values overwritten by a later duplicate key, belong to the Json category. Valid objects, strings, numbers and null are not decoding failures merely because they are not arrays. Existing SQL/type/text/schema integrity failures remain distinct and unchanged.

`StoreJsonError` has a static message retaining the baseline field context. It does not include raw input, parser text or a cause graph. The existing native store diagnostic admits only the exact nominal source error and transports the closed `{kind:'Json'}` tag. The reconstructed native message is static. Envelope binding, admitted-submission checks, actual native joins, private joined-cause association, 512-byte diagnostic budget and exact two-child cleanup aggregate rules remain unchanged.

Shared queue callers still receive `NativeQueueReadUnavailableError`; only the existing joined prompt-authority port unwraps the store diagnostic. A public error constructor or decoded tag cannot enroll an error in that private joined association. This is typed classification, not preservation of JavaScript reference identity across workers.

## Immutable Rust comparison

Repository `simdorei/codex-discord-remote-rust`, commit `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`:

- [queue/read.rs:61–85](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-store/src/queue/read.rs#L61-L85), blob `51908634a7bf40ea1aa5073f212e7f39b93a0a5e`: state decoding precedes `serde_json::from_str::<Value>`; non-array and mixed-array behavior is retained.
- [error.rs:17–32](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-store/src/error.rs#L17-L32), blob `261d7959f547966b8562d13a07da24879dd4bba1`: serde errors become `StoreError::Json`, distinct from Integrity.
- [server_prompt_authority.rs:61–76](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/server_prompt_authority.rs#L61-L76), blob `000c612ad050850ed468306f693cc3f80288aa98`: the complete queue read propagates Store failures.
- [server_prompt_redisplay.rs:89–112](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/server_prompt_redisplay.rs#L89-L112), blob `ca8ccd8a0b6bdf286814d3cc89dea082a4e6efb7`: Store errors propagate rather than becoming unavailable-authority UI.

These are independently inspected immutable sources, not an executed Rust artifact comparison. The correction preserves this category boundary; it does not reproduce Rust parser text, line/column details or arbitrary nested causes.

## Installed-core and transaction regressions

The changed decoder is used by `selectJob`, `allJobs`, the existing filtered reads and their native List adapter. The installed prompt-authority port uses that same full queue decoder. This is an existing operational path, not a dormant codec or new service.

The real-resident regression starts the existing `startRuntimeResident` fixture, retains its original child, receiver and approval occurrence, and uses actual SQLite plus native prompt reads and receipt storage. It checks both malformed syntax and numeric overflow through authority verification, redisplay, direct delivery and recovery:

- The error retains Json classification and is not converted to unavailable-authority UI.
- There are zero transport callbacks, delivery receipts, response rows and child answers while the baseline is invalid.
- The exact original request/occurrence remains pending.
- Restoring `[]` lets the same delivery owner recover the original prompt, persist its native receipt and avoid a second send on repeated recovery. The approval remains unanswered and pending.

The transport callback and returned message ID are passive branch witnesses. This is genuine resident/store/native-owner coverage with passive delivery transport, not an HTTP test or evidence of remote acceptance. Existing actual Integrity refusal checks remain in the same fixture.

Direct store tests retain successful non-array/mixed-value behavior, large integer/canonical number cases, malformed syntax and overwritten-key overflow. Generation adoption still rolls back when a complete queue read encounters a malformed unrelated row. Start-failure's trigger-induced corruption still rolls back its mutation. Preflight failure still reads its original target scope, ignores unrelated malformed rows where it did before, and rolls back on malformed matching rows. No transaction assertion was removed.

The separate `queue-baseline.ts` parser contract is unchanged. Its regression suite is included, but this checkpoint does not claim universal store JSON-error parity.

## Fresh bounded qualification

Final author and independent runs used separate frozen roots, pinned Node 24.21.0 and TypeScript 7.0.2, explicit allowed dependency traversal and the existing 300-second owned-process supervisor. Both passed the same nine complete test files, with **137 passed and zero failures, cancellations, skips or todos**. Results overlap and are not added together.

- Strict selected compilation: 354 project modules and 178 declarations.
- Strict production compilation: 341 project modules and 178 declarations.
- All 341 production JavaScript emissions match the selected compilation byte-for-byte.
- Author and independent source and emission maps match.
- All 607 current/frozen inputs, 608 physical frozen copies, 354 selected emissions, 341 production emissions and pinned Node bytes remained unchanged in each run.
- Private home/temp directories were empty afterward. No broad repository discovery, protected-path read, HTTP suite or full-application compile was selected.

The exact nine suites and seven changed source/test hashes appear in the [public evidence manifest](stored-queue-json-970-manifest.json). The remaining two changed files are this document and that manifest. No raw logs, database files, credentials or private absolute paths are included in the public evidence.

Author evidence root basename: `store-json-parity-970-author-20261017-Fhkt0dHM`.

- Manifest SHA-256: `39dbef0fdb7bb88b36046daede3286823fad5e1c66abd2952ad3a966201fe7ef`.
- Test receipt SHA-256: `395a17509f3b53e677a5aae6a501eda0d14081c957077c1c1b8a7a4a95f7732f`.
- Post-test audit SHA-256: `bdf0238d5ec4f0e8176564b2e3e8fda8e32c09940b3dbf5e2dfc405b1f58798d`.
- Natural test exit 0 after 28.771704 seconds; supervisor total 28.802652 seconds.

Independent evidence root basename: `store-json-parity-970-review-20261017-6cORvOQs`.

- Manifest SHA-256: `d3bce90ea3937332454ff75978537ac449bcab23f88f46d5119c8053f63260a7`.
- Test receipt SHA-256: `9975249ef9b18b40423057e0b710e42c836cb05123f0f9f63df58e663ac3c94a`.
- Post-test audit SHA-256: `0c0f2f4db8f84d1ab8f8d42be63e419e0af0b4a73cba9f0d4977be3137cf5e3b`.
- Natural test exit 0 after 28.801262 seconds; supervisor total 28.832159 seconds.

Every compiler/test phase recorded owned-process exit, EOF and a no-children wait result, without forced signals, shutdown reason or supervisor error. Each test receipt observed 15 owned identities. Supervisor teardown evidence is separate from application cleanup assertions and is not an application-cleanup guarantee.

Shared source graph SHA-256: `172cbbfdac032452a9219600b04cd4474cfc6b3255cc06c0183c886a474365b1`.
Shared production emission map SHA-256: `c4f769fef81acb81f1f1bec457f2db1445c063a204c36f3049dc6d74da3db599`.
Shared selected emission map SHA-256: `0fc0c2c6b25dc1505d7e0be6d9a0e9f8e98c0019337cd9469d6f787af673136e`.

## Remaining trajectory and limits

This removes a concrete existing source-category mismatch and exercises safe failure-to-recovery behavior. It does not install a persistent owner or new prompt-read mediation service. Original receiver/caller ownership, direct local-tool form behavior, cancellation joins and receipt identities are unchanged.

Genuine HTTP/installed-startup behavior, authentic operational root attachment, physical-store/external-writer exclusion, persistent activation, live app-server/computer-use operation, full local-application/guard semantic compilation, performance/soak and deployment remain unqualified. The supervisor does not establish filesystem/network/cgroup/namespace isolation. Historical V4 descendants remain unknown and untouched; no current process-list absence was used as closure evidence.

The next end-to-end work remains the original installed caller/receiver graph and its permitted qualification gates, including the full persistent owner dependencies. Existing socket restrictions do not block ordinary source review and bounded allowed tests, but this checkpoint does not bypass the positive root/HTTP qualification requirements. There is no overall A–G PASS or migration-completion claim.
