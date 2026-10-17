# Native mirror policy pre-admission harness

Status: pre-admission harness PASS only, independently reproduced 40/40 on
2026-10-16. Native worker execution, database reads, and migration completion
remain unqualified. The existing native execution hold is unchanged.

The standalone candidate is
`test/runtime/discord-runtime/native-mirror-policy-preflight.harness.mjs`.
It must be copied unchanged into the identical relative test directory beside
an independently reviewed emitted JavaScript tree. It accepts no module URL,
path selector, test discovery, or command-line configuration. Its only dynamic
imports are the three fixed relative `.js` modules named in its source.
The source and exact runner received independent boundary review before these
two runs. Any changed source, import closure, or runner requires fresh review.

## Boundary

The first import is the previously reviewed passive OwnedWorkerSlot closure.
Before importing the native mirror policy owner or InteractionAccessPolicy, the
harness checks all five own configurable function descriptors: run, runCpu,
runControlCompletion, runObservationCompletion, and runMaintenanceRead. It
replaces all five with one synchronous, unique Error sentinel and invocation
counter. The replacements are non-writable and non-configurable and remain
installed until process completion. Original methods are never called; there is
no deliberate valid submission or guard self-test. A guard invocation fails the
harness, even if a surrounding owner converts or catches the sentinel.

Every case and the final result require zero guard invocations, zero accessor or
proxy-trap invocations, and zero native usage in all five lanes. Usage is read
through the existing snapshot function; counters are not modified. There are no
mocked busy states, joins, results, admission-refusal proofs, Worker or
MessagePort constructions, database operations, filesystem calls, or network
calls in the harness. Module loading and writing its fixed result to stdout are
runner mechanics, not application I/O qualification.

## Forty sequential cases

- Five invalid paths: non-string, unpaired surrogate, NUL, more than 32768 UTF-16
  code units, and more than 32768 UTF-8 bytes with fewer code units.
- Sixteen scalar-limit failures: four each for rows, value bytes, output IDs,
  and timeout, checking exact RangeError detail.
- Six passive-record failures: missing, accessor, inherited, proxy, null, and
  function limits, checking exact TypeError detail without running input code.
- Three private-policy receiver failures: ordinary lookalike, prototype
  lookalike, and proxy around a genuine policy. TypeError, sentinel exclusion,
  otherwise valid inputs, and zero guard/trap counts establish the rejection
  boundary; no public lookalike method may run.
- Five order cases: genuine pre-aborted AbortSignal with exact reason identity,
  abort before invalid path/limits/policy, path before limits/policy, and two
  limits-before-private-policy cases.
- Five factory cases: path before limits, invalid limits, original path mismatch,
  mismatch before abort/private receiver, and matching path with original abort.

The empty path is valid in production and is not asserted to fail. Synthetic
path strings are bounded and never opened. The installed factory is only invoked
with an unequal original path or a genuinely pre-aborted signal. Async owner
cases require a Promise rejection; installation/mismatch cases require a
synchronous throw. Engine-specific private-field error wording is deliberately
not asserted.

## Result and limits

The one-process harness emits one fixed-schema JSON result and exits nonzero on
failure. Success requires exactly 40 completed cases and zero entries into all
guarded submission methods. No Node test discovery or subprocess wrapper is
used by the harness. Its assertions cover only pre-admission rejection behavior
and first-failure ordering. They cannot establish real admission/refusal,
worker exit, cancellation after submission, SQLite behavior, cleanup, response
validation, native capacity, installed ingress, or end-to-end migration parity.
Source review and any later approved harness result must remain separate from
those still-held runtime claims.


## Frozen qualification evidence

Both author and independent reviewer ran the same immutable v2 harness directly
in a single pinned Node 24.21.0 process with `--no-strip-types`. Neither run used
`--test`, test discovery, or a test subprocess wrapper. The separate supervisor
recorded actual natural Node exit code 0, stdout EOF (141 bytes), stderr EOF
(0 bytes), and no stream overflow for each run. These exits apply only to the
new guarded harness processes; they do not establish termination of descendants
from the earlier v4 native fixture run.

Both fixed JSON results report 40 completed cases out of 40, guardCalls 0,
passiveCalls 0, nativeUsageZero true, and preAdmissionHarnessPassed true.
Post-run freeze verification succeeded for both runs without changing the
harness, package metadata, or any of the exact 35 emitted source modules.

- Tested harness SHA-256:
  `9632096c33329d07abb374e305295a8e1b514e39f202491f65f04dcc1defb38d`
- Reviewed emitted 35-module closure digest:
  `98c8253ff452c334f8a26ff46e33d33e8e0f2494c5aefd815f7be866806eae1e`
- Complete v2 freeze manifest SHA-256:
  `7ec4adb4bf2a3e1e0cb3cb86cdddd42131adc5f374698ea8278f9407045e5620`
- Pinned Node binary SHA-256:
  `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c`
- Supervisor source SHA-256:
  `81a6076e92489cb998b9950abcb4f6760e2398eaf2ac9f2bb0b4308c2e915d96`
- Each author/reviewer result receipt SHA-256:
  `1300d0c0317ce92c6b831ccf9535b337aed4f1847fc81f0bc59c71be578a5a00`
- Each author/reviewer post-run freeze receipt SHA-256:
  `7dc28d65ee1c9283f9842ffb8b5e72ed4d881e55d7d09e8fbfae0dce5fbc4e1a`

The preserved v1 source was never executed. Before either run, v2 replaced an
engine-specific private-field error-message predicate with TypeError plus the
existing sentinel exclusion and zero guard/trap assertions. This was a source
portability correction, not a failed runtime result. No tested harness bytes
were subsequently changed.

The permanent guards cover the actual five submission methods in this frozen,
reviewed import closure. They are not a general sandbox or proof against arbitrary
future code introducing another submission route. The harness never submits a
valid native operation and does not qualify real policy database reads, busy or
refusal provenance, actual native joins, post-admission cancellation, or v4
cleanup. Native behavior and v4 cleanup remain explicitly false in both result
receipts. Production source is unchanged by this harness checkpoint.
