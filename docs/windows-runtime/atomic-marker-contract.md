# Checkpoint 927: private Windows atomic marker publication profile

Status: **limited-input, uninstalled WIP; cloud mock contract only. Windows
native qualification: NOT RUN.** This is neither a WindowsDrainMarkerStore nor
a runtime activation or full parity claim. Koffi remains uninstalled. No CLI,
dependency, store authority, existing codec, POSIX authority, or checkpoint
925/926 file changes belong to this slice.

Only three new files belong to the candidate:

- `src/runtime/windows/windows-atomic-marker.ts`
- `test/windows-runtime/windows-atomic-marker.test.ts`
- `docs/windows-runtime/atomic-marker-contract.md`

## Authority and lifecycle

`acquireWindowsAtomicMarkerProfile(root)` privately acquires an authentic 926
owner through the real production acquisition function. The profile never
exposes that owner, HANDLE, binding, filesystem port, completion resolver, or
cleanup callback. A frozen, empty, null-prototype profile is authenticated by
exact identity in a private WeakMap. Live profiles, operations, and debt are
strongly rooted independently of caller references. Copied, inherited, forged,
proxied, revoked-proxy, foreign-context and test-context objects cannot confer
production authority. The brand is a compile-time convenience only.

The 926 owner holds named-mutex existence, not mutex wait ownership. It continues
to enforce its main-thread/platform/architecture and same-name custody gates.
Importing 927 loads no native library. Its private move binding is lazily
constructed through the real zero-argument 925 factory before filesystem work.
No caller-supplied binding or structural lease can replace this boundary.

`publishWindowsAtomicMarker(profile, selector, text)` admits exactly one active
operation. Admission failures throw synchronously. Active custody and its
completion Promise are installed before the lazy loader, phase callbacks,
filesystem calls, or any await. There is no queue. The admitted operation can
finish after shutdown seals subsequent admission.

`shutdownWindowsAtomicMarkerProfile(profile)` seals immediately and installs its
cached exact Promise before any callback or await. It joins the admitted
operation through filesystem close, actual native callback and cleanup, then
releases the private singleton once. Repeated and reentrant calls share the
same Promise. Unresolved native launch stays pending indefinitely; no timeout,
cancellation, forced cleanup, retry or optimistic release exists.

This join guarantee belongs exclusively to the 927 profile. Ordinary
`releaseWindowsSingletonOwner()` from 926 still closes directly and gains no
writer lease or join guarantee. An independently caller-held 926 token cannot
be passed to this writer. A future API taking such a token needs genuine lease
integration in 926, not an assertion followed by an await.

## Limited paths and text

The root must be a primitive printable-ASCII drive-absolute string beginning
with a letter, colon, and slash or backslash. Relative, drive-relative,
root-relative, UNC, device/verbatim, control/DEL/NUL and non-ASCII roots are
refused. Every internally generated native path must fit **259 UTF-16 code
units excluding NUL**, including the longest temporary name. With no trailing
separator, a 191-unit root plus separator plus the 67-unit temporary leaf is
exactly the limit. A trailing slash/backslash is preserved and used directly.

No normalization, realpath, trimming, separator/case rewrite, dot collapse,
junction resolution, physical-alias discovery or long-path opt-in occurs. The
exact admitted root spelling goes to the 926 owner and remains an unchanged
prefix of both source and destination. Invalid Windows components can still
fail filesystem I/O. ASCII root qualification does not imply canonical or
physical-directory identity; 926's Local-session/truncated-hash limitations
remain unchanged.

Only these selectors and internally fixed leaves exist:

- `identity`: `.codex_discord_rust.drain.identity`
- `ack`: `.codex_discord_rust.drain.ack`

Text must be primitive, well-formed Unicode and at most **4096 UTF-8 bytes
inclusive**. UTF-16 length is bounded before surrogate scanning or encoding;
byte length is checked before Buffer allocation. Empty text and embedded NUL
content are allowed; native paths cannot contain NUL. Exact UTF-8 bytes are
written without normalization. The profile deliberately does not parse marker
semantics or import the wider existing encoder/store graph.

The 4096-byte write ceiling is a deliberate limited profile, not full Rust
write parity: the frozen Rust reader has that limit while its atomic writer
does not impose this write-size limit. Unicode filesystem roots, MAX_PATH
opt-in/verbatim paths and platform filesystem validation are deferred.

## File/native transaction and ambiguous outcomes

The operation creates the parent directory, generates one same-directory UUID
temporary, and opens it exclusively with `wx` and mode 0600. Mode 0600 is not
Windows ACL qualification. Ownership begins only after open succeeds. A
collision is never retried, truncated, removed or treated as owned.

It writes all bytes with explicit advancing offsets, handles partial writes,
rejects zero progress, awaits sync and then awaits close. Only a proved close
permits native submission. The private real 925 binding calls asynchronous
`MoveFileExW` with exactly flags 9, replacing the destination with write-through.
There is no destination unlink, copy, synchronous native move, or production
Node rename fallback.

The first write/sync error stays primary if close or cleanup also fails. Close
is primary only when preceding stages succeeded. A completed native failure
stays primary over failed cleanup. Public failures are fixed, frozen, redacted
`WindowsAtomicMarkerError` observations with primary reason/phase, outcome,
explicit file debt, safe native diagnostics and numeric DWORD when available.
Raw exceptions, causes, paths and arbitrary exception properties are omitted.

A launch exception from 925 does not prove non-submission. Its submission,
temporary, binding, active slot and private owner remain retained until the
actual callback. Late callbacks and callback-before-launch-throw remain
authoritative. A successful callback wins over a launch diagnostic, which is
still reported separately. A nonzero signed BOOL succeeds despite stale DWORD.

A callback binding error can occur after the physical move, including failed
callback-local DWORD capture. Such an outcome is **unconfirmed**, never a proof
that the old destination remains. No rollback or destination deletion occurs.
After actual callback and proved file close, only the owned temporary pathname
may be cleaned. ENOENT discharges that pathname debt, including when replacement
already consumed the source. A completed zero BOOL reports `not-published`.

Failed close retains the actual FileHandle and owned pathname, skips unlink,
and quarantines the profile. Failed owned-temp cleanup retains pathname debt
and also quarantines it. New writes are refused; no close or cleanup retry is
attempted. Shutdown joins the failed operation and reports `unresolved` with
null owner-release observation, retaining the singleton rather than claiming a
clean release. If file work is discharged but real 926 release is unresolved,
its existing name debt blocks reacquisition and no second close is attempted.

The containing directory is trusted against unrelated pathname replacement.
Remembering a successful exclusive-open pathname does not prove inode identity
against hostile external renames/junction changes. This is not a filesystem
sandbox or anti-adversarial alias protocol.

## Cloud test boundary

The separate trusted harness accepts raw mock Koffi plus an explicit exact
Windows-root-to-disposable-cloud-directory mapping. It internally creates a
separate authentic 926 test owner and real 925 test binding. Test objects never
authenticate in production. The harness accepts no structural owner/native/FS
port or arbitrary native completion Promise. Mapping is explicit test evidence,
not proof of Windows path resolution or owner-root equivalence.

Ordinary mkdir, exclusive open, writes, sync, close and unlink use real cloud
files. Test-only finite phase controls can hold or fail operations and force
bounded partial/zero-progress writes. Only the raw mock-native adapter renames
the real temporary to emulate replacement, then calls the supplied native
callback. Controls cannot forge owner state or directly settle native
completion. Deliberately unresolved scenarios retain module-rooted debt; test
fixture removal is external test teardown, not profile recovery.

## Predeclared 24-category selected matrix

This matrix and the selected compiler graph are frozen for independent review
before candidate compilation/execution. Revisions require a new freeze.

1. Import safety; main-thread/platform/architecture refusal before filesystem I/O.
2. Exact opaque identity, forged/proxied/foreign/test-to-production rejection.
3. Fixed destinations and exact unchanged root/path construction.
4. Root/generated-path boundaries and all excluded root classes.
5. Exact UTF-8/non-BMP, lone-surrogate refusal and 4096/4097-byte boundaries.
6. Same-directory exclusive `wx`, unchanged foreign collision, no collision cleanup.
7. Complete/partial writes, advancing offsets and zero-progress failure.
8. Write, sync, close, then native submission ordering.
9. Write/sync/close and earlier filesystem failures prevent native submission.
10. Primary-error precedence with combined close/cleanup failures.
11. Old destination until replacement; new bytes only through the native mock.
12. No destination unlink, copy, sync native move or production rename fallback.
13. Exact flags 9, callback-local DWORD and nonzero BOOL plus stale DWORD.
14. Zero BOOL, callback, result and capture errors.
15. Capture error after actual simulated replacement leaves new target intact
    with unconfirmed outcome, including harmless source ENOENT cleanup.
16. Single active operation across every filesystem/native/cleanup phase,
    synchronous/reentrant busy refusal and no queue.
17. Shutdown at every held phase, immediate seal and no premature CloseHandle.
18. Launch throw/no callback retains operation, pending shutdown, owner and temp.
19. Late success/failure after throw, callback-before-throw and duplicate callback.
20. Reentrant/repeated exact shutdown Promise and one release.
21. Quarantined close/cleanup debt refuses subsequent writes and clean release.
22. Dropped caller references trigger neither cleanup nor release.
23. Genuine 926 unresolved owner close blocks reacquisition; proved close plus
    failed capture remains a closed diagnostic observation.
24. Unchanged selected 925/926 suites alongside the new suite.

Verification uses existing pinned Node **24.21.0** and TypeScript **7.0.2**, the
explicit CLI with strict NodeNext/ES2023 flags and private output directories.
The selected roots are precisely the three Windows source files and three
Windows test files. A separate source-only parity compile admits precisely
the same three source files. Actual compiler-file lists must be audited for
both graphs. Only declaration files from the existing TypeScript libraries,
`@types/node`, `undici-types` and TS7's
`node_modules/@typescript/typescript-linux-x64/lib/` are additionally permitted.
Emitted JavaScript executes with `--no-strip-types`.

These are focused checks, not a full build. Protected redaction/native-read
remote-agent paths are excluded before reads and never read, compiled, run or
reconstructed. No project-wide scripts, installation, native library execution,
live operations, Git writes, upload, deployment, historical evidence rewrite,
checkpoint 893 activation or UNIX-listen EPERM retry belongs to this work.

## Native gates and source references

Windows x64 and ARM64 remain separate **NOT RUN** gates: verified Koffi prebuild
loading and compiled ESM/Node compatibility, actual marshalling/callback error
restoration, Node/Win32 path agreement, replacement visibility/write-through,
sharing/ACL/antivirus failures, junction/alias behavior, Rust/TS contention,
crash/death/restart, unresolved close retention, responsiveness and leaks.
Device availability by itself passes none of these gates.

- [Frozen Rust marker writer and reader](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/restart_readiness/drain_marker.rs)
- [Frozen Rust Windows atomic replacement](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-windows-native/src/atomic_file.rs)
- [Microsoft MoveFileExW contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
- [Microsoft maximum file path limitation](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)
