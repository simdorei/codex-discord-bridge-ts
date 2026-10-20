# Checkpoint 928: bounded Windows qualification tooling

Status: **cloud refusal/orchestration candidate; Windows x64 and ARM64 native qualification NOT RUN**.
This additive tool does not activate the runtime, install Koffi, or establish production readiness.
Checkpoints 925–927, package manifests, runtime/CLI wiring, and historical evidence stay unchanged.

## Frozen candidate and verification graph

The candidate consists only of:

- `tools/windows-qualification.ts`
- `tools/windows-qualification-artifacts.json`
- `test/windows-runtime/windows-qualification.test.ts`
- this document

The selected compiler roots are exactly the three existing production modules
`src/runtime/windows/{windows-native,windows-singleton-owner,windows-atomic-marker}.ts`,
the tool, and the new test. The source-parity roots omit only the test. A second
production-only comparison may use the three existing source modules. The tool
has no static production import: its fixed child entry dynamically imports
those exact modules only after host, invocation, artifact, and fixture gates.
The supervisor never calls a native factory. No child uses a `ForTest` factory.

Use the existing `.runtime/node24/node_modules/node-linux-x64/bin/node` version
24.21.0 and `node_modules/typescript/bin/tsc` version 7.0.2. Invoke the CLI with
explicit roots, `--ignoreConfig --target ES2023 --module NodeNext
--moduleResolution NodeNext --strict --allowImportingTsExtensions true
--verbatimModuleSyntax true --noUncheckedIndexedAccess true
--exactOptionalPropertyTypes true --types node --skipLibCheck false
--rewriteRelativeImportExtensions true --rootDir . --noEmit false`, and a unique
private `--outDir`. Before compilation use `--listFilesOnly`; audit actual lists
against only the exact roots and declaration files under
`node_modules/typescript/lib/`, `node_modules/@typescript/typescript-linux-x64/lib/`,
`node_modules/@types/node/`, and `node_modules/undici-types/`.
Run only the emitted qualification test using `--no-strip-types --test`.
Compare emitted source bytes between selected and parity graphs. No project
build script, broad test discovery, source execution, or existing Windows suite
is part of this graph. The earlier suites intentionally require non-Windows.

Freeze file hashes and these expectations before compiler/candidate execution.
Any reviewed revision receives a new freeze and rerun. Protected
`test/remote-agent/redaction.test.ts` and remote-agent paths containing
`native-read` are excluded before reads and never compiled or reconstructed.
Checkpoint 893 stays inactive; a UNIX-listen EPERM is never retried.

## Safe default and explicit native invocation

Running the emitted tool without arguments or with `--help` only prints
instructions. It creates no fixture, launches no child, resolves no Koffi, and
loads no native addon. Explicit native mode first requires the main thread,
`win32`, process architecture `x64` or `arm64`, exact Node 24.21.0, and the closed
argument form. Unsupported hosts are refused before paths are inspected.
Source/base/root spellings and derived fixture path bounds are checked as
arguments before dependency or filesystem reads.
Only `--no-strip-types` is admitted as an executable argument; `NODE_OPTIONS`
and `NODE_PATH` must be absent. Importing the tool is inert.

After separately reviewed preparation, the invocation is:

```
<exact verified node.exe> --no-strip-types <emitted>/tools/windows-qualification.js --native --source-root <checkout> --fixture-base <approved existing local directory>
```

No installation command is supplied or run by the tool. Dependency preparation
requires its own explicit authorization, isolated staging, exact reviewed
artifacts/lock, and install scripts disabled. Never run Koffi `install.js`, CMake,
source-build fallback, a package manager, or an automatic download from this tool.

## Artifact identity and explicit blockers

The JSON manifest is an expected-identity document, not a learning cache. It
pins the 925–927 source bytes, tool source, corresponding emitted JavaScript,
Windows Node executable per architecture, Koffi 3.3.3 archive SHA-512, selected
prebuild archive SHA-512, every audited loader-closure file, prebuild metadata,
and exact `.node` SHA-256. Missing/null fields are a NOT RUN blocker. Never fill
an expected value by hashing an encountered device install. Expected identities
must come from an independently reviewed immutable distribution/build.

Resolution is checked from the emitted `windows-native.js`, including the exact
selected prebuild entry. The standalone qualification output must own its
`node_modules` staging; ancestor resolution is refused. The fixed archive files
live under the output's `artifacts/`. The seven reviewed loader/prebuild files are the exact allowed closure.
Resolution is also anchored at Koffi static.cjs to exclude nested/ancestor
shadowing. The build/koffi/win32_{arch}/koffi.node fallback must be absent and
process.resourcesPath is refused. The output package.json must be exactly
`{"type":"module"}` followed by a newline. Child factories must load exactly the expected `.node` in the CommonJS
cache, with no additional native addon. Neither version text alone nor a test
shim counts as a genuine load. No successful result can override an artifact
failure. Registry integrity does not establish reproducible binary provenance.

The checked-in expectations deliberately block targets without separately
verified Windows Node/emitted/prebuild closure identities. Device availability
alone does not fill these gaps. The cloud host is not a Windows qualification
source. Process architecture is reported separately from the unverified machine
architecture; x64 execution on an ARM64 device cannot certify native ARM64.

## Fixtures and closed file protocol

The caller supplies an existing, approved local fixture base. No guessed
`C:\Temp`, live bot root, elevation, ACL change, long-path toggle, 8.3 spelling,
network socket, shell, IPC channel, process enumeration, or process-tree kill is
used. Roots must be short printable-ASCII drive-absolute backslash spellings,
without relative/dot segments, reserved components, alternate data streams,
UNC/device/verbatim paths, trailing dots/spaces, or Unicode. Existing components
are checked for symlinks/junctions and realpath changes. A random 96-bit nonce
names an exclusively created run directory; fixed per-case subdirectories and
leaves are the only writable paths. Every generated 927 native path remains
below its 259-unit bound. Exact captured spelling is shared by cooperating
children. This is trusted-directory hygiene, not hostile reparse-race or
physical-alias security proof.

Children receive only fixed mode/case/role/selector, nonce and fixture arguments.
Mode/case/role/selector combinations and the nonce-bound wq-<nonce>/c<case-index>
root shape are also checked before the internal child entry can inspect files.
The executable and emitted script are fixed. `spawn` uses `shell:false`, ignored
stdin, bounded stdout/stderr, and an environment allowlist of SystemRoot and the
owned TEMP/TMP. Credentials, PATH, NODE_OPTIONS and NODE_PATH are not inherited.
Only direct children are owned; there are no grandchildren or listeners.

A packet is immutable JSON created with exclusive open, fully written, synced,
and closed before its separately closed ready sentinel. The sentinel contains
the nonce. Fixed filenames bind role and sequence; the packet binds nonce,
case, role, sequence, finite event/status/cleanup fields and bounded counters.
Commands have a separate closed four-field schema. Receivers reject stale,
malformed, oversized, missing or unexpected fields; no raw child error or payload
is forwarded. A receipt is necessary but not sufficient: terminal PASS also
requires the actual exit event and matching stdio-close event with exit 0.
A child's report, `kill()` return or PID observation cannot prove termination.

Frozen containment budgets (not performance thresholds):

- at most 3 direct children live in a case
- 5 seconds per protocol transition, 30 seconds per case
- 5 minutes beginning before artifact/root checks, with 5 seconds reserved for exit/close grace
- 4096 bytes per packet, 128 immutable sequence slots per role/direction
- 65536 bytes separately per child stdout/stderr
- 32 replacements per selector, 16384 reader samples per selector case
- at most 1000 polls per transition, 10 ms between missing-sentinel polls
- at most 1024 entries per case and 8 expected data leaves at cleanup

Every supervisor filesystem/FileHandle await passes through the same deadline
guard, including artifact reads, setup, inspection and nonrecursive removal.
Per-case budgets cover setup through cleanup. Async-local transition scopes
cap every protocol I/O await at its actual 5-second deadline. All clocks are
monotonic, and settled operations recheck the deadline before reporting success. Expiry permanently stops new
steps. A timed-out OS operation can still be pending; the summary retains
pending/uncertain-I/O debt rather than claiming cancellation or completed close.
Deadlines bound orchestration only. They never settle a native callback,
manufacture CloseHandle success, retry cleanup, or allow profile release.
On failure/timeout, the case is stopped monotonically and only its own still-live
direct children may be terminated once. The tool then requires actual exit and
close. Missing termination evidence stops later native work. Any failed or
uncertain case root is retained even after forced process exit. Safe removal is
restricted to roots with proved normal child exits, closed cleanup reports, and
an inspected exact ownership set. That set contains only supervisor-created
commands, received immutable packet slots, the owned owner record, and the exact
data leaves produced by the selected case. A syntactically valid but unreceived
slot is foreign. Files are unlinked one by one, followed by empty-directory
removal; no recursive deletion is used. Unexpected files or remaining native
temporaries fail cleanup and retain the root.

## Native matrix, separately per architecture

1. Genuine exact verified Koffi load through real 925; pending/quarantine zero.
2. Fresh 926 acquisition, exact-root held assertion, cached release Promise,
   proved closure, explicit reacquisition and release.
3. TS holder A, contender B observes 183 plus closed duplicate handle; B exits,
   A closes and exits, fresh C reacquires. Repeat reversed role labels in a fresh
   case. The cooperation uses exactly the same captured root.
4. Dedicated owned holder death after held receipt, actual exit and close,
   followed by a fresh process reacquisition. This proves observed OS lifetime,
   not a clean owner shutdown.
5. Real 925 replacement of an old target, actual callback/nonzero BOOL, exact new
   target bytes, absent source and zero pending debt. Missing leaf and missing
   parent must yield frozen DWORDs 2 and 3, sequentially and through separate
   interleaved bindings, with bounded Node/V8 and synchronous native activity.
6. Real 927 identity and ack publication: empty, Unicode/NUL/non-BMP, exact 4096
   bytes; synchronous refusal of 4097 bytes and unpaired surrogate. Exact target
   bytes, clean profile shutdown and no leftover native temporary.
7. For each selector, a filesystem reader confirms old before every replacement,
   samples during a real 927 writer, and confirms new before the next round.
   Every observed read must be a complete old or new body; missing/error/partial
   reads fail. All 32 rounds are required. Exhausted observations are incomplete,
   never a visibility PASS.
8. Immediately shut down an admitted real publication: exact cached shutdown
   Promise, immediate seal, subsequent write refusal, publication before shutdown
   settlement, closed debt-free release and fresh reacquisition.
9. A separate native-phase observation case checks the public real status while
   publication is pending. It receives PASS only if `phase === 'native'` was
   actually seen before requesting shutdown. An unobserved phase is INCONCLUSIVE.
   No phase hook, mock callback, synthetic native hold or timing guarantee is
   introduced. Observing a status is not an independent native argument trace.
10. Child accounting and fixture cleanup are checked for every case.
11. Rust interop remains NOT RUN: this version has no admitted Rust executable
    mode. A future additive implementation requires an exact reviewed Rust
    fixture source/build/binary/architecture and bounded protocol, then both
    contention directions. An arbitrary executable path is never accepted.

The fixed 925 source exercises flags `0x9`; this is not independent call tracing
or power-loss durability evidence. Existing real APIs cannot force lost
callbacks, failed closes, or native-phase holds safely. Those, ACL/AV/sharing
failures, junction races, cross-session behavior, Unicode/long roots, native
leaks, physical alias identity, crash/power-loss durability, and full runtime
integration remain unqualified. Do not infer them from cloud or subset PASS.

## Frozen cloud matrix and evidence format

Cloud tests exercise the shared supervisor choreography and real disposable
file protocol, using process-event mocks that cannot create native evidence:

- defaults and host/argument refusals, including the actual compiled entry
- exact finite budgets, short-root refusals, missing identities and graph closure
- packet schema, stale nonce/case/role/sequence, unknown/oversized/malformed fields
- actual shared supervisor setup/admission/protocol/finalization with cloud
  process mocks, including failed cleanup and honest INCONCLUSIVE retention
- actual read-only staged dependency bytes, static/absolute resolution,
  tampering, forbidden fallback and nested shadow resolution without executing
  any staged file
- deadline expiry, pending-I/O debt, late-continuation refusal and child cap
- receipt before exit, exit without close, close without exit, mismatched close,
  nonzero exit and early exit
- unresolved cleanup or failure report despite clean process exit
- bounded timeout, one-shot owned kill, kill failure and output poisoning
- both contention orderings and stopping before release/reacquire on failure
- death completion before reacquisition
- every old/new handshake in both 32-replacement selector cases
- closed-payload/sentinel order, exclusive immutable slots, unknown files,
  lingering native temporary and symlink cleanup refusal
- absent Rust does no work; raw paths, handles, payloads and exceptions never
  appear in sanitized diagnostics

The native summary carries finite per-case PASS/FAIL/NOT RUN/INCONCLUSIVE,
fixed reason enum, artifact hashes, bounded callback/read/replacement counts,
observed numeric DWORDs, explicit native/file/process uncertainty and pending-I/O debt,
observed native phase, expected/observed child exit/close counts, and retention
status. It omits absolute paths, usernames, handles, raw errors/stacks,
environment and marker payloads. A bounded closed failure packet carries only
a fixed reason and uncertainty flags; a missing failure report retains unknown
debt instead of turning an early exit into a clean refusal. Cloud pass must always be labeled cloud
orchestration/refusal evidence; native architectures remain NOT RUN until actual
authorized device execution of this exact reviewed artifact set.

A retained flag means retained-or-uncertain, not proof that every pathname still
exists: an already-submitted unlink/rmdir may settle after timeout. Pending-I/O
and uncertainty fields preserve that distinction. No later removal is submitted
after expiry. Source and emitted staging directories must also satisfy the
short local ASCII-directory gate.

Final run-directory removal failure preserves valid case observations but emits
aggregate cleanup FAIL and a nonzero process exit. Preflight/setup timeouts
also report pending/uncertain I/O even when no case row has started.

Dependency staging is immutable throughout verification/loading. Node caches
module resolution; this is not a defense against a same-user actor changing
package directories between checks and load. Cloud shadow-resolution fixtures
therefore place the shadow before the first resolution from a fresh parent.
A just-exited child receives one final bounded closed-receipt read, preventing
a missing-sentinel/exit race from discarding a receipt closed before exit.
Absent or nonterminal receipts still cannot pass.
