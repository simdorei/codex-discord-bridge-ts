# Checkpoint 925: gated, uninstalled Win32 binding contract

Status: source prototype and cloud mock contract only. **Windows native qualification: NOT RUN.**
Koffi is not installed or added to the manifest/lockfile. This module is not imported
by the runtime. No native binary or install script is executed by these tests.
This is not a dependency-security certification or a Windows support claim.

## Frozen scope and expected behavior

The slice adds only `src/runtime/windows/windows-native.ts`, its selected test,
and this document. It contains no root-name hashing, singleton owner, store
authority, mutex acquisition policy, marker writer, runtime wiring, package
change, dependency installation, or native qualification runner.

The real zero-argument factory checks `process.platform === 'win32'` and
`process.arch` in `x64 | arm64` before calling
`createRequire(import.meta.url)('koffi')`. It requires the CJS module's named
`version === '3.3.3'` and `load`, validates `library.func` and callable function
objects plus the move function's `.async`, and fails closed otherwise. It does
not guess a default-export fallback or declare a pretend ambient Koffi module.
The trusted test seam supplies only host facts and the captured module loader;
it never loads Koffi and is not a production fallback.

Only `kernel32.dll` and these four declarations are bound:

```c
void * __stdcall CreateMutexW(void *attributes, int32_t initialOwner, str16 name)
uint32_t __stdcall GetLastError(void)
int32_t __stdcall CloseHandle(void *handle)
int32_t __stdcall MoveFileExW(str16 source, str16 destination, uint32_t flags)
```

`CreateMutexW` always receives `(null, 0, name)`; `MoveFileExW.async` always
receives `(source, destination, 0x9, callback)`. BOOL is signed int32, DWORD is
unsigned int32, and HANDLE is a nonzero uint64-range bigint or null. No pointer
is converted through JavaScript number. There is no caller-controlled symbol,
DLL path, attributes pointer, owner flag, publication flag, or synchronous move.

Inputs must be primitive strings without embedded NUL. Exact UTF-16 code units
are preserved without normalization. Both paths are captured before submission;
Koffi synchronously marshals the immutable strings and retains its async argument
storage until completion. No caller-owned mutable container is used as input.
This binding does not establish that a caller's name/path is authorized or
canonical. Those decisions belong to a later layer.

## Native results and error capture

`kind: 'win32'` is a native observation, not an automatic success verdict.
The returned HANDLE/BOOL determines success; last-error can be stale on success.
For example, `CreateMutexW` can return a real handle with error 183. That handle
still needs closing, and `bInitialOwner = 0` does not acquire mutex ownership.
The future singleton layer must close and refuse an already-existing instance.
This slice neither implements that policy nor calls WaitForSingleObject or
ReleaseMutex.

The bound `GetLastError` is invoked immediately after each synchronous native
return, before output validation or any other FFI. For an actual async native
result it runs synchronously inside the native completion callback, before
Promise settlement. A callback binding error is classified separately, without
inventing a DWORD. No code awaits a move and then tries to recover its error.

The pinned Koffi source explicitly preserves Windows error context across the
worker/JavaScript-thread boundary. Its forward-call wrapper restores
`TEB.LastErrorValue` from `TEB.EnvironmentPointer` before a native call, then saves
it afterward. Async execution captures that saved worker value; callback
completion installs it around the JavaScript callback and restores the previous
main-thread context on callback return. Thus callback-local bound GetLastError
uses the saved worker value. This source behavior still needs actual Windows
qualification, including under Node/V8 work and interleaved failures.

Binding, invocation, validation, and error-capture failures use a fixed typed
error with operation/phase only. Raw messages, causes, custom properties, stacks,
names, and paths from the dependency are discarded. A Win32 zero BOOL or null
handle with captured DWORD is not relabeled as a binding exception.

## Explicit cleanup evidence

A valid returned mutex handle plus failed DWORD capture is never discarded.
The result carries a quarantined cleanup object retaining the exact handle.
Its `close()` is one-shot and cached, including after invocation failure.
Only a validated nonzero int32 CloseHandle result proves `closure: 'closed'`.
That proof survives a subsequent GetLastError capture failure. A zero, malformed
or thrown CloseHandle result remains unresolved; no retry or fake close proof
is supplied.

A malformed returned handle or a CreateMutexW invocation exception creates
explicit unknown-ownership quarantine. It retains the raw candidate privately,
but never invents a pointer conversion or calls CloseHandle on an invalid value.
An invocation exception does not prove that native side effects did not occur.
A returned null handle does prove there is no returned handle to clean up, even
if later error capture fails. The public `quarantinedMutexCount` reports retained
debt. Quarantined raw handles and exceptions are not exposed as authority.

Ordinary successful creation returns a raw bigint to its caller; that caller
must keep custody and close it. This low-level port is not an authentic owner
token, and possession of a duck-typed object grants no higher-level authority.

## Async submission and join

Move submission returns `{state, launchError, completion}`. At most one move per
binding is pending. `completion` settles only from the actual native callback.
A synchronous `.async` invocation throw records a redacted launch error but does
not settle completion, clear pending debt, retry, cancel, or authorize release.
If a callback subsequently arrives it supplies completion evidence. If it never
arrives, completion remains pending and the binding stays unavailable for another
move. If callback completion occurred before a launch exception, it remains
authoritative. Duplicate callbacks do not recapture error or change the result.

`pendingMoveCount` makes debt explicit. Module, DLL, fixed function references,
pending input captures, and quarantines are strongly retained for process
lifetime. There is no unload, reset, timeout, cancellation, Promise.race, or
timeout-as-completion path. A future coordinator must stop admissions and join
actual completion before releasing its owner. This narrow layer does not promise
cleanup of a forever-ambiguous native submission.

## Frozen selected verification matrix

Cloud tests are expected to establish:

- import-safe non-Windows refusal and x64/ARM64-only loader gating
- missing module, wrong version, malformed surface/getters, and redacted failures
- exact four declarations, DLL, argument positions, int32/DWORD widths, fixed flags
- captured references surviving mutation of the injected trusted surface
- null/valid/wide/malformed handles and Unicode preservation with NUL refusal
- DWORD captured before validation/continuation, and no numeric narrowing
- returned-handle cleanup quarantine, unknown ownership, one-shot close evidence
- successful close plus failed capture remains proved closed; failed close remains debt
- async-only publication, pending state and overlap refusal
- callback-local DWORD, Win32-vs-binding failures, duplicate callbacks, distinct errors
- launch exceptions retain callback-only join debt, including callback-before-throw

Only the two selected TypeScript roots are compiled into a private output with
the existing pinned Node 24.21.0 and TypeScript 7.0.2 CLI. Compiled JavaScript runs
with `--no-strip-types`. A separate source-only production-parity compile checks
the source under the same NodeNext/ES2023 strict options; this is not a full build.
No historical tests, runtime, protected sources, package scripts or native addon
are run by this slice. Expectations are frozen before test execution; changes
following review require a new frozen candidate and rerun.

## Official reviewed dependency evidence

Exact source: [official koffi 3.3.3 npm archive](https://registry.npmjs.org/koffi/-/koffi-3.3.3.tgz).
The dependency review verified SHA-512 integrity and the npm registry signature
without installation or binary execution. Main archive integrity:

```text
sha512-XWNI4eyxJJzR2MakPZzR3QeZ06JOklLbxglin0dHhx/qIQCby8lqHs9Acq4Q7CpCKnOrBSj+6b9J5y69wfr2ZA==
```

Reviewed members in that immutable archive:

- `package/src/koffi/index.cjs`: CJS named `load` and `version` plus default native export
- `package/index.d.ts`: version and callable function `.async` API
- `package/src/koffi/src/util.hh:403–413`: bigint/null pointer representation
- `package/src/koffi/src/interp.cc:332–353`: Win32 forward-call error save/restore
- `package/src/koffi/src/call.cc:1645–1675`: async function/callback/memory lifetime
- `package/src/koffi/src/call.cc:1696–1738`: worker error capture and callback restoration

Public API references: [Koffi load](https://koffi.dev/load),
[Koffi pointers](https://koffi.dev/pointers),
[Koffi changelog](https://koffi.dev/changelog).
Win32 contracts: [CreateMutexW](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createmutexw),
[GetLastError](https://learn.microsoft.com/en-us/windows/win32/api/errhandlingapi/nf-errhandlingapi-getlasterror),
[CloseHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-closehandle),
[MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).

The package install script can try a source rebuild after prebuilt loading
fails. It has not run here. Future authorized qualification must deliberately
disable install scripts, verify the exact selected Windows prebuild, and load it
explicitly; no silent source-build fallback. Registry integrity/signatures are
not reproducible native-binary provenance or a security-clean certification.

## Gates still NOT RUN

Windows x64 and ARM64 are separate gates. Neither has been exercised:

- compiled ESM and pinned Node 24.21.0 loading the exact verified prebuild
- fresh/existing/error mutex calls, error 183 then fresh creation, nonmutex name collision
- actual pointer/BOOL marshalling, async worker DWORD restoration, main-context restoration
- Node/V8 work between calls, distinct/interleaved native failures and event-loop responsiveness
- Rust/TypeScript and TypeScript/TypeScript contention in both directions
- GC, process/helper/worker death, unresolved close and unjoined native cleanup retention
- canonical root/Unicode/hash agreement and authentic higher-level store authority
- full marker publication, write-through behavior, failure/crash/temp ownership and leak checks

Later device availability does not itself pass any gate or authorize claiming
production readiness from this mock-only contract.
