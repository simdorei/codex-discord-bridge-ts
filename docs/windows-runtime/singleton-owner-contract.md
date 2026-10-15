# Checkpoint 926: uninstalled Windows singleton owner

Status: **limited-input WIP; cloud mock contract only. Windows native
qualification: NOT RUN.** This is not full Windows parity or a runtime support
claim. Koffi remains uninstalled, and this module is not imported by runtime or
CLI entry points. Checkpoint 925 and its evidence remain unchanged.

## Frozen boundary

Only three files belong to this slice:

- `src/runtime/windows/windows-singleton-owner.ts`
- `test/windows-runtime/windows-singleton-owner.test.ts`
- `docs/windows-runtime/singleton-owner-contract.md`

There is no package/dependency change, marker writer, store enrollment, POSIX
authority change, runtime activation, native move, helper ownership, worker
ownership, finalizer, automatic retry, timer, unload, or reset. The production
acquisition function takes only a root spelling. It requires the main thread
and internally calls the real zero-argument `createWindowsNativeBinding()` from
925. It never accepts a caller HANDLE or structural native binding. Importing
the module does not load Koffi. 925 still gates Win32 and x64/ARM64 before loading.

The owner holds a returned named-mutex handle for singleton existence. It does
not take mutex wait ownership: 925 passes `(null, 0, name)` to `CreateMutexW`.
There is no `WaitForSingleObject` or `ReleaseMutex` operation.

## Limited lexical naming qualification

The frozen Rust algorithm is SHA-256 of the root's lossy-string lowercase UTF-8,
first 16 lowercase hex characters, prefixed with `Local\CodexDiscordBot_`:

- [Rust runtime root naming, lines 122–137](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/runtime_instance.rs#L122-L137)
- [Rust singleton creation and error 183, lines 14–28](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-windows-native/src/single_instance.rs#L14-L28)
- [Rust handle drop, lines 29–33](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-windows-native/src/process/handle.rs#L29-L33)

This slice admits only a primitive printable-ASCII string beginning with an
ASCII drive letter, colon, and slash or backslash, of at most **65,536 UTF-8
bytes inclusive**. Every admitted code unit is one UTF-8 byte. Relative,
drive-relative, root-relative, UNC, device/verbatim paths, control characters,
DEL, NUL, non-ASCII, and lone surrogates are rejected before loading or FFI.
Objects and boxed strings are never coerced or inspected. ASCII lowercasing
avoids claiming equivalence between JavaScript and frozen Rust Unicode tables.
Supporting other root classes requires a separately reviewed qualification.

Admission is a lexical subset, not filesystem validation: it does not prove
that a directory exists, that every component is legal on Windows, that the
caller used a canonical path, or that two spellings name the same directory.
There is no realpath, case-independent filesystem lookup, separator rewriting,
dot-segment collapse, trailing-slash/space removal, NFC/NFD, short/long-name
resolution, or junction/symlink resolution. Slash, dot, and trailing spelling
remain exact. Case variants share a name, but held assertions still require
the exact original root spelling. Physical aliases can get different names;
different roots can collide in the truncated **64-bit** digest. `Local\` scopes
the mutex to a Windows session, not all sessions or machines. This is not a
collision-free or physical-directory identity protocol.

### Frozen independent literal name vectors

These values were computed independently with Python standard-library SHA-256
over ASCII-lowercased bytes before candidate compilation or execution. They do
not import the candidate or derive expected values through its name helper.
Root spellings below use JSON escaping; the prefix is `Local\CodexDiscordBot_`.

| Root spelling | First 16 hex characters |
| --- | --- |
| `"C:\\"` | `3dc8472eaebe1a9d` |
| `"C:\\Repo"` | `c4866a467d261ea3` |
| `"c:\\rEPO"` | `c4866a467d261ea3` |
| `"C:/Repo"` | `619c46f38f5cfecb` |
| `"C:\\Repo\\"` | `3bc36924e70cba40` |
| `"C:\\Repo\\.\\Child"` | `9d935467d50b0aa8` |
| `"C:\\Repo\\..\\Other"` | `c78d6818d9c3ef9e` |
| `"D:\\PROJECT WITH SPACES"` | `30ccd501119c6037` |

## Identity and custody

Successful acquisition returns a frozen null-prototype object with no own
properties. A private WeakMap authenticates exact token identity; a separate
module-rooted per-name Map strongly retains each live token, original root,
binding, handle/quarantine, lifecycle, and close evidence. A caller dropping a
token does not release it. Tokens carry no raw HANDLE, path, binding, callable
cleanup method, or structural proof. Copies, proxies (including revoked
proxies), inherited objects, forged properties, and tokens from other contexts
cannot authenticate. Authentication never reads token properties.

A provisional entry is inserted before loading as well as before native
creation. Same-name loader/create reentry, held overlap, in-progress release,
and unresolved debt all fail closed without another loader/native attempt.
Different names are independent. `assertWindowsSingletonOwnerHeld(token, root)`
requires the exact token, held lifecycle, and exact captured primitive root,
not merely its case-folded name or digest.

The trusted test factory takes host facts plus a raw mock Koffi loader and itself
calls `createWindowsNativeBindingForTest()`. It never accepts a structural port.
Every harness has a completely separate, module-rooted registry. Its tokens
always fail production assertion and release; no mock-to-production promotion
or test reset exists. The TypeScript brand is only a compile-time convenience,
not authority.

### Acquisition outcomes

- A valid non-null handle with any captured DWORD other than 183 becomes held.
  A stale nonzero DWORD does not override a successful handle.
- Error 183 with a returned handle calls `CloseHandle` exactly once and always
  refuses an owner, whether cleanup closes or remains unresolved.
- Null returns refuse without any close. A null return plus failed DWORD
  capture still has 925 ownership `none`, so provisional custody can end.
- Factory refusal ends the provisional reservation because this layer has not
  called `CreateMutexW`.
- Known-handle quarantine from 925 uses that quarantine's existing one-shot
  `close()`; the owner never reconstructs or publicly exposes the handle.
- Malformed results or invocation uncertainty retain unknown debt permanently.
  No pointer is invented and no unknown-result `CloseHandle` is attempted.

For possible-handle custody, only 925's `closure: 'closed'` removes the strong
per-name reservation. Zero, malformed, thrown, or otherwise unresolved closes
retain binding and name debt. Later explicit acquisition is allowed after
proved closure; there is no implicit acquisition or cleanup retry.

### Release and diagnostics

`releaseWindowsSingletonOwner(token)` assigns its cached Promise and invalidates
held state **before** synchronous `CloseHandle`. Reentrant and repeated releases
share that exact Promise and one attempt. A successful close does not restore
the old token's held authority. Releasing the old token again cannot close a
new owner's handle. No callback, timer, GC event, or caller mutation initiates
release.

The frozen close observation contains `closure`, a nullable redacted 925
`diagnostic`, and nullable numeric BOOL/DWORD observations. A validated nonzero
int32 close proves `closed` even if subsequent DWORD capture fails; that
diagnostic is reported separately without retaining a fake unresolved handle.
When 925 reports a binding error it does not expose the BOOL/DWORD observations,
so those numeric fields are null. Zero remains unresolved even with a valid
DWORD. Failed closes are never retried.

Refusals are frozen `WindowsSingletonOwnerError` values with fixed operation and
reason, explicit custody, and nullable safe native diagnostic/DWORD/cleanup.
Raw native exceptions, messages, causes, stacks, properties, roots, handles and
quarantine objects are not exposed. The public error class and observation
shape grant no ownership authority.

## Frozen selected verification matrix

Expectations are frozen before compiling or executing the candidate. A changed
candidate gets a new freeze and rerun. The selected matrix covers:

1. Independent literal names, prefix/length/case agreement and non-normalization.
2. Primitive ASCII drive-root and exact 65,536-byte limit; excluded root classes,
   final control characters, lone surrogates, boxed strings, and no coercion.
3. Import-safe production non-Windows refusal, production worker preloader
   refusal, harness host gates, x64/ARM64 mock admission, and structural-port
   rejection. The worker only tests refusal; it owns no native resource.
4. Frozen opaque tokens; exact-root assertion; fake, copied, inherited, proxied,
   revoked, foreign, mock-to-production, and released-token rejection.
5. Loader and native-create reentry; held/in-progress/debt same-name overlap;
   independent names and factory failure without residual provisional custody.
6. Exact uint64-width handle custody and stale success DWORD behavior.
7. Error 183 always refuses, with exactly one close; closed diagnostic failures,
   zero/malformed/thrown cleanup and permanent unresolved debt.
8. Null with normal, 183, or failed DWORD capture never closes.
9. Reused known-handle quarantine on malformed/thrown DWORD capture; successful,
   zero, malformed, thrown, and failed-capture cleanup observations.
10. Malformed handles and native invocation exceptions retain unknown debt with
    no invented pointer, close, retry, or later acquisition.
11. Release invalidation before FFI, reentrant/repeated Promise identity, one-shot
    close, released-token invalidity, and safe explicit reacquisition.
12. Signed int32 BOOL bounds, stale DWORD, successful close with capture failure,
    zero/malformed/thrown/failed-capture unresolved release and no retry.
13. Dropped caller references do not trigger close or remove name custody.
14. Only create/capture/close/capture calls; no move, wait, or release-mutex.

Verification uses the existing pinned Node **24.21.0** and TypeScript **7.0.2**
CLI, explicit selected roots and private output directories. The actual compiler
file list must contain exactly the two Windows source files and the selected
925/926 tests, plus dependency declaration files. A separate source-only compile
under identical strict NodeNext/ES2023 options must contain exactly the two
source files plus dependency declaration files. Emitted JavaScript runs with
`--no-strip-types`. These focused checks are not a full project build.

The prohibited redaction/native-read remote-agent sources are excluded before
reads, never compiled, run, or reconstructed. No historical evidence, runtime,
package script, native addon, native installation, live service or Git write is
part of this slice. Checkpoint 893 remains inactive and UNIX listen EPERM is
never retried.

## Windows gates still NOT RUN

Mocks cannot establish actual Win32 behavior. Windows x64 and ARM64 remain
separate, unrun gates, including exact verified Koffi prebuild loading under
compiled ESM/Node 24.21.0, pointer/BOOL/DWORD marshalling, fresh/existing/error183
and nonmutex collisions, Rust-to-TypeScript and TypeScript-to-Rust contention,
TypeScript-to-TypeScript process contention, real OS/session/hash/physical-alias
behavior, process death and OS lifetime behavior, real close failure and GC
pressure, and Unicode/frozen-Rust differential agreement. Store authority,
canonical filesystem root validation, marker publication, native worker joins,
crash/leak qualification and full runtime integration are out of scope.

The source's strong references and mock reentry tests are not substitutes for
those gates. Availability of a Windows device alone passes none of them.
