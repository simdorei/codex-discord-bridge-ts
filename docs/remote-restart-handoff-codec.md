# Remote restart handoff pure codec (915)

This is an **uninstalled, pure-data codec and validation slice**. It creates no restoration authority and does not enable a CLI, runtime root or remote connection. Its synchronous exports have no filesystem, environment, dispatcher, credential, protector, network or startup dependency. Input/output values are ordinary data. Nothing is persisted, and no plaintext persistence fallback exists.

## Source authority

Verified read-only from `simdorei/codex-discord-remote-rust` at commit `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`:

- [restart_handoff.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff.rs), blob `e9cf21f68965c2adf780dca5c544bddd5dd677f3`: format/protocol, 120-second writer deadline, 128-project maximum, 1,048,576-byte protected envelope, source write/claim ordering.
- [restart_handoff/model.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff/model.rs), blob `83a44b4cd120c6a2340948b8c18597368560327b`: exact required fields and `deny_unknown_fields` on envelope, payload and projects.
- [restart_handoff/validation.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff/validation.rs), blob `427b7662a6de44c34d5741e6f5d6f107025bca48`: fingerprint, semantic validation order and separate canonical-directory check.
- [dispatcher.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/dispatcher.rs#L62-L86), blob `6e42420d8f684dd5863b7926cb5cbed2f6cea7cc`: source snapshot filters expired bindings and sorts UTF-8 thread IDs; source restore iterates the vector.
- [runner.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/runner.rs), blob `a711839bd0c467058f7aed0c02f30c9794f94006`, and [restart_handoff/lifecycle.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff/lifecycle.rs), blob `a90123390f77667dd5a5e107aa73b892676cff8f`: lifecycle context, not implementation supplied by this codec.
- [restart_handoff/storage.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff/storage.rs), blob `eddb0bf5d33edf2677ef0f395b7ad6e2f1ecb70f`: native protection/atomic storage are outside this slice.
- [Chrono 0.4.45 positive-duration leap-second arithmetic](https://github.com/chronotope/chrono/blob/v0.4.45/src/naive/time/mod.rs#L605-L640), blob `5a35aa38447c02d9d882697f5632f243dae9b093`: adding positive whole seconds exits a represented leap second by removing its extra nanosecond billion before adding seconds.

Tests are synthetic, source-derived contract tests, not newly executed Rust oracle observations.

## Public data boundary

`restartHandoffGatewayFingerprint` receives only an exact two-field passive `{bridgeUrl, deviceId}` record. The URL string must already be the Rust `Url` display/normalized representation supplied by the configuration boundary. The codec does not normalize, trim, parse, authorize or connect to a URL. It hashes UTF-8 URL bytes, a NUL byte, then exact device-ID bytes with SHA-256, producing lowercase hexadecimal. A token field is neither accepted nor read.

`encodeRestartHandoffPayload` returns in-memory plaintext JSON, or `null` for an empty project vector to represent Rust's skipped write. It emits format 1, protocol 10, the fingerprint, `created_at = now`, `resume_until = now + 120 seconds`, and projects in source declaration order. Project input order, duplicate IDs, empty strings and noncanonical root strings are preserved. The writer does not invent reader expiry checks. No plaintext is sent to a storage or protection callback.

`decodeRestartHandoffPayload` returns a deeply frozen data snapshot after schema and semantic validation. It does not canonicalize a root, check existence/directory type, install bindings or produce a capability. Datetimes use the existing Chrono parser/formatter and bounded bigint seconds/nanoseconds, preserving nanoseconds and represented leap seconds.

`encodeRestartHandoffEnvelope` accepts caller-supplied canonical standard-base64 ciphertext and emits exactly `format_version`, then `ciphertext`. `decodeRestartHandoffEnvelope` returns validated base64 data. Neither proves encryption happened, encrypts/decrypts, accepts a protector callback or establishes any relationship between an envelope and separately supplied plaintext. Empty ciphertext is syntactically valid, as in Rust's standard base64 engine. Whitespace, URL-safe alphabet, missing/excess padding and nonzero trailing pad bits fail.

## Schema, order and errors

All envelope/payload/project fields are required and non-null. The version fields are unsigned 8-bit integer JSON tokens; decimal/exponent forms, negative zero, strings and out-of-range values fail rather than being coerced. Derived Serde structs accept either an object map or an exact-position sequence. Maps allow arbitrary key order but reject unknown keys and duplicate fields, including escaped-key aliases. Sequences reject missing or trailing fields. Trailing JSON, malformed Unicode and malformed nested values fail before semantic validation.

For valid contextual arguments, the source order is preserved:

1. Check the envelope's UTF-8 byte ceiling, deserialize its complete schema, check envelope format, then validate standard base64.
2. Separately deserialize the complete plaintext payload schema.
3. Validate payload format, protocol, exact fingerprint, `resume_until > now`, nonempty projects, at most 128 projects, then every `expires_at > now`.
4. Rust would next canonicalize each project root and require a directory. This step is deliberately absent.

Semantic errors use the source's static categories/messages. All parser, shape, datetime and coercion failures are converted to static `Malformed` diagnostics, without retaining input, parser causes, root paths, device values, ciphertext or nested errors. Size failures use static `TooLarge`. No getters, Proxy traps, coercion or `toJSON` are invoked while capturing supported input. Exact owned enumerable fields are required; prototypes, symbols, sparse arrays, extra fields and opaque objects fail closed.

## Intentional limits and non-claims

- Rust's **1 MiB limit applies to the serialized protected envelope**, including JSON/base64 overhead, both after protection on write and before parsing on read. This codec preserves that envelope ceiling. It additionally caps plaintext codec input/output at 1 MiB, and separately caps binding text and aggregate project text at 1 MiB, to bound synchronous local work. That plaintext cap and strict JS passive-shape checks are TS safety adaptations, not Rust protected-file or heap/RSS guarantees. The largest intermediate JSON encoding may exceed the output cap by bounded escaping overhead before rejection.
- The source's writer creates a 120-second deadline, but its reader does **not** compare `created_at` with the current clock, require `resume_until - created_at == 120 seconds`, or reject a future creation time. This codec preserves those limitations rather than inventing skew policy. The caller supplies the clock; no clock is sampled. Chrono-range overflow is safely reported as malformed rather than reproducing a Rust arithmetic panic.
- Duplicate project IDs remain in the decoded vector. Source restore subsequently upserts in vector order, while the existing TS managed boundary intentionally rejects duplicates. This codec does not relax that installed policy or deduplicate/sort silently. The source snapshot's sorted output is the dispatcher's responsibility, not the writer's.
- The 128-project native handoff contract does **not** change the separate [910 dispatcher](remote-dispatcher-ownership.md) and [911 managed](managed-remote-ownership.md) **16-project** integration limit. This module is not installed in either.
- There is no OS/current-user protection, key handling, protected storage backend, atomic replacement/sync, storage-path selection, claim-by-rename, claimed-file removal, normal-start/resume gate or single-use replay protection. Repeated calls can decode the same data repeatedly. No session/cache/queue/uncertain mutation is restored.
- [912](synthetic-remote-runtime.md) remains explicitly synthetic/loopback-only. 913 remains uninstalled WIP with its separately blocked independent review unverified. This slice does not review or qualify 913. 893 remains inactive. Common startup/root integration and all reserved Windows paths are unchanged.
- No live database, credential lookup, operational service, UNIX-root retry, Git write, upload, external message, deployment or release/install action is performed.

## Verification

Pinned Node 24.21.0 and TypeScript 7.0.2, emitted JavaScript with `NODE_OPTIONS=--no-strip-types`. The private compiler configuration uses an explicit selected-file list and exact protected-test exclusion; no all-suite builder is used. The protected test is never read, compiled, run or reconstructed. The known UNIX-root EPERM case is not exercised or retried.

Focused tests cover exact serialization/fingerprint, all semantic precedence, required/duplicate/unknown/null/trailing schemas, map/sequence acceptance, 128/129 projects, preserved duplicates/order, exact expiry/nanoseconds/leap arithmetic, source skew/replay limitations, passive hostile inputs, standard base64 strictness, UTF-8 envelope limits and redacted errors. Bounded affected tests cover the reused Chrono and Serde leaves. Counts and final-byte verification are recorded in the scoped result receipt; they do not qualify a full suite, runtime, platform protection, claim-by-rename, performance or production restore.

Final scoped verification: **63 focused tests and 174 bounded affected tests across six selected test files passed**, with zero failures, cancellations or skips. Selected-graph strict typecheck and production build exited 0. All **nine selected production modules** byte-match the emitted test graph. These overlapping counts are not a full-repository result.
