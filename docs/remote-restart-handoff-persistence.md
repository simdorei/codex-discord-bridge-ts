# POSIX remote restart handoff persistence and claim (920)

This is an **uninstalled POSIX filesystem slice** over the [915 pure codec](remote-restart-handoff-codec.md). It writes an explicitly protected envelope and consumes one pathname entry by rename. It returns immutable project data, not restored bindings, runtime admission, a capability, or a production restart implementation. There is no default protector, plaintext fallback, environment-variable lookup, credential discovery, default storage-path discovery, CLI wiring, or managed/runner integration.

## Source authority and boundary

The source contract is `simdorei/codex-discord-remote-rust` at verified commit `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`:

- [restart_handoff.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff.rs), blob `e9cf21f68965c2adf780dca5c544bddd5dd677f3`: writer/claim order, 128 projects, 120-second writer deadline, 1,048,576-byte protected envelope, claim cleanup and error precedence.
- [restart_handoff/validation.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff/validation.rs), blob `427b7662a6de44c34d5741e6f5d6f107025bca48`: full semantic validation precedes directory canonicalization; canonical roots replace supplied spellings; vector order/duplicate IDs remain.
- [restart_handoff/storage.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff/storage.rs), blob `eddb0bf5d33edf2677ef0f395b7ad6e2f1ecb70f`: same-directory unique claim naming and atomic replacement. Rust's system protector is unsupported on non-Windows; this slice does not replace it with a claimed OS-protection implementation.
- [restart_handoff/model.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff/model.rs), blob `83a44b4cd120c6a2340948b8c18597368560327b`: payload/envelope/project fields. Schema and time/fingerprint behavior remain supplied by 915 unchanged.

Tests are source-derived synthetic TypeScript/native-filesystem observations. No new Rust oracle, native platform-protector, production-runtime, live-data, or performance qualification is claimed.

## Explicit public API

`writePosixRestartHandoff(path, projects, binding, now, protector)` returns `Promise<boolean>`. `claimPosixRestartHandoff(resumeRequested, path, binding, now, protector)` returns `Promise<readonly RestartHandoffProject[]>`.

The caller provides an absolute well-formed POSIX handoff path, exact passive binding/time records, and an exact passive `{protect, unprotect}` record containing non-Proxy functions. No protector is installed by this module. Both functions are captured before the first asynchronous boundary and invoked detached, without a receiver. This is a trusted active callback boundary: the caller is responsible for choosing real authenticated protection and controlling its lifetime. The module cannot infer encryption, key custody, authenticity, or current-user binding from bytes. Tests use only a fresh in-memory AES-256-GCM key in each disposable fixture.

Callbacks accept copied `Uint8Array` data and return `Uint8Array`/`Buffer`, or an ordinary native `Promise` of those bytes. Supported promises have `Promise.prototype` and no own constructor, or an own data constructor equal to `Promise`; harmless async-context symbols and own `then` accessors are ignored. Generic thenables, Proxy callbacks/byte results, shared backing memory and unsupported result types fail closed. Exotic native promises with hostile constructor/species accessors or subclasses are outside the trusted async contract and are not qualified, including their independent unhandled-rejection behavior. Callback code and ambient builtin mutation are not sandboxed.

Typed-array backing buffer/offset/length are read through intrinsics; caller getters/iterators are not invoked. Synchronous returned bytes are copied before the first await, asynchronous bytes immediately on settlement before subsequent I/O. No callback/native error object, nested cause, filesystem path, plaintext, ciphertext or binding value is retained in diagnostics. Existing codec errors remain static; persistence adds static stage errors.

## Write ordering and completion

1. Reuse 915's passive synchronous project/context capture and encoding. An exact empty vector returns `false` without reading path, binding/time, protector, or filesystem. More than 128 projects fails before protection. The writer preserves supplied vector order/duplicates and leaves project expiry checking to the reader.
2. Capture/validate the explicit absolute path and protector callbacks. The path restriction avoids a publication destination changing after `process.chdir` during protection.
3. Protect an in-memory plaintext copy. Encode the returned ciphertext as canonical standard base64 inside the format-1 envelope. Enforce the full serialized 1 MiB envelope ceiling **before creating a directory or opening a file**.
4. Reuse `runtime/atomic-marker.ts`: recursively create the parent, create a unique same-directory owned temporary with `wx` and mode `0600`, write the protected JSON, fsync the file, close the handle, then rename over the destination. Failure attempts removal only of a temporary successfully created by this invocation; a cleanup failure does not replace the publication failure.
5. Return `true` only after the real rename resolves. A blocked protector, fsync, close, or rename is still pending, not completed or cancelled.

The helper is unchanged. This is POSIX namespace atomicity with file fsync, **not** parent-directory fsync, power-loss durability, Windows write-through replacement, or secure publication against hostile ancestor/path replacement. Existing destination content survives failures before replacement.

## Claim ordering, ownership and cleanup

1. `false` returns a frozen empty vector without inspecting any other argument or touching a file. For enabled claims, capture binding, supplied time, path, protector and root working-directory context before awaiting filesystem work. Invalid enabled-call context can therefore fail even if the file is absent, an explicit JS boundary adaptation.
2. Stat the source. Missing yields empty; a directory/non-file fails. Like Rust metadata, stat follows a source symlink. Rename the source into a fresh UUID-named claimed entry in the same directory. The suffix omits Rust's process ID; UUID uniqueness supplies the per-invocation distinction. A rename `ENOENT` race yields empty. Other stat/rename errors reject without claiming ownership.
3. Open the claimed file, inspect handle metadata, and read into a fixed **max+1** buffer. Initial oversize fails; short reads loop; growth after metadata can consume at most 1,048,577 bytes and is rejected before parsing. Always attempt handle close, preserving an earlier read/size failure.
4. Decode strict UTF-8 without BOM stripping; parse/validate the envelope, format and canonical base64; unprotect a copied ciphertext; copy/bound/strictly decode plaintext; reuse 915's full payload schema and semantic validation. Invalid UTF-8 cannot become replacement characters accepted by JSON.
5. Only after all payload semantics, including every project expiry, pass, realpath each root and require its canonical result to be a directory. Preserve order and duplicate thread IDs. A later unavailable/file root fails the whole result; no partial vector is returned. Relative roots are raw-joined to a working-directory string captured synchronously before the first await; symlink/parent traversal is not lexically normalized. This is async context pinning, not an environment-variable or storage-location lookup. Empty roots fail rather than being coerced to the working directory.
6. Always attempt unlink of **the unique claimed pathname**, regardless of read, decrypt, validation or root failure. The original failure wins if unlink also fails. Successful validation plus failed unlink rejects, including `ENOENT`; valid projects are returned only after successful removal.

The source pathname is never used for claim cleanup. A newer publication can appear while an older claim is decrypting, and removing the older claimed entry leaves the new publication intact. Two concurrent claims of one unchanged entry produce at most one nonempty result. This is pathname consumption, not global replay prevention: copies, retained symlink targets, or later republishes can be claimed again. There is no hostile-rename/symlink race guarantee, stale-claim scavenger, cleanup timeout, retry-to-success fiction, or conversion of cancellation into completion.

## Preserved limitations and exclusions

- 915's separate 1 MiB plaintext/aggregate-input bounds, passive exact-record capture, bounded UTC fields, schema checks and static semantic errors remain. Ciphertext byte results are additionally bounded before base64 allocation. These are bounded-work adaptations, not heap/RSS limits or Rust protected-file limits applied to plaintext.
- The caller supplies the time. No later clock, creation-time skew check, new cleanup deadline, or resume-window extension is invented. A long-running callback does not revalidate against elapsed wall time. Timeouts/cancellation and production lifetime management are absent.
- Source roots are canonical data, not security authority. This does not install restored projects, resume sessions, replay queued/uncertain mutations, or change dispatcher admission. The 128-project handoff contract does not change the 16-project managed/dispatcher integration limit.
- 911/912/CLI are untouched. 912 remains synthetic/loopback-only. 913's separately denied independent native-read review remains unverified; this slice does not inspect or qualify it. 893 remains inactive, with no authority activation. Frozen 917/918/919 measurement originals remain unchanged.
- Reserved Windows paths, live paths/databases/services, credential/environment discovery, UNIX-listen EPERM retry, TCP substitutes, deployment, installation, main-branch merge and external publication are outside this slice.

## Verification scope

Pinned Node **24.21.0**, TypeScript **7.0.2**, emitted JavaScript executed with explicit `--no-strip-types`. The private config has seven exact test roots: the new persistence test, 915 codec, datetime, datetime-format, serde-struct-json, serde-json and serde-json-parse. It excludes the protected redaction test by exact path. That protected file is never read, compiled, executed or reconstructed; no broad build/test entrypoint is used.

The selected production graph has twelve modules: persistence, codec, datetime, datetime-format, core serde-struct-json/serde-json/serde-json-parse, protocol IDs, discord text/gateway values, atomic-marker and runtime path-text. No 911/912/913 or CLI root is installed or exercised. A separate production-only explicit-root build must byte-match the production modules emitted by the selected test graph.

Focused coverage includes authenticated ciphertext-only disk, file mode and operation order, delayed actual completion, input/output mutation, detached/passive callbacks, native async rejection, exact envelope ceiling, oversized/growing/short reads, strict outer/plaintext UTF-8 and BOM rejection, missing/non-file/ENOENT races, concurrent claims, newer publication survival, close/cleanup error precedence, withheld results until unlink, expiry-before-root lookup, canonical root order/duplicates, unavailable roots, and retained symlink-target replay limits. Filesystem fault injection wraps real disposable fixture operations and restores native exports afterward; it adds no production filesystem injection interface.

Final author verification: **54 focused tests and 228 bounded affected tests across seven selected files passed**, with zero failures, cancellations or skips. The counts overlap. Selected strict typecheck, selected test compilation and separate production build exited 0; all **twelve production modules** byte-match the emitted test graph. Immutable candidate hashes and receipts are recorded in the scoped verification receipt. This is not a full-repository, production-platform, performance, or restart-installation pass.
