# Windows/npm migration implementation — 2026-10-18

## Result and source identity

The Windows implementation is packaged as **0.1.0-alpha.2**. This report
supersedes the alpha.1 checkpoint: its unimplemented automatic mirror, native
remote adapters, recovery, watchdog, archive deletion and administration entries
are now implemented. Installation uses npm and compiled JavaScript; consumers do
not need Cargo or a TypeScript compiler.

- Repository: `simdorei/codex-discord-bridge-ts`.
- Remote starting branch: `sss/async-admission-cloud` at
  `4c2f0e1e62829e15f274858c6b41a28066212d86`.
- Implementation branch: `codex/ts-npm-windows-20261018`.
- Prior npm checkpoint: `d745491f03bf9bed66e97df5281dda7b34848f2f`.
- Pinned Rust reference: `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`.
- Verified environment: Windows x64, Node **24.21.0**, Koffi **3.3.3**.
- Existing dirty Rust and other TS checkouts were preserved.
- No live bot replacement, real Discord send, model request, scheduled-task
  registration, Desktop recovery, PC reboot, main merge or registry publication
  was performed.

## Implementation matrix

| Surface | Implemented behavior |
| --- | --- |
| npm and executable discovery | Compiled CLI/workers, current-directory configuration, explicit `--env`, installed plugin/recovery assets. Automatic discovery skips incomplete Codex installations and falls back to an older complete Codex/code-mode-host pair. An invalid explicit `CODEX_EXE` remains an error. |
| Runtime and child ownership | Rust-compatible Windows mutex and atomic markers; Job Objects own app-server and command descendants. Actual child/worker exit precedes releasing ownership; uncertain effects retain evidence. |
| Queue, final delivery and stop | Existing durable attempts and receipts retained. Installed runtime adds bounded waits for native capacity, with original completion persistence taking priority. Independent thread-idle checks no longer share one rejecting busy flag. No effect retry or automatic replay was added. |
| Automatic session mirror | Installed producer with file identity and a v3 SHA-256 anchor over the entire consumed prefix. Middle rewrites followed by append are detected. Explicit legacy-cursor migration acquires exclusion, makes a backup, and preserves offset, turn and timestamp; ambiguous sources stay held. |
| Pro/plugin integration | Owned bounded inventory process and pinned Windows file observations. Package-local manifest and explicit Pro skill path use the same installation; runtime-local plugin overrides remain supported. |
| Configured remote MCP | Real configured gateway connection and native project/session adapters. Non-loopback service connections require WSS; restart bindings use current-user DPAPI, expiry and single-claim ownership. |
| Project files and checkpoints | Read/search/rules/create/write/patch, expected-hash compare-and-swap, pinned ancestors, durable pending checkpoints before effects, rollback/restore and bounded retention. External edits are preserved. |
| Project Git, images and terminals | Fixed command catalog, bounded owned processes and output, public HTTPS image validation, per-session terminal cwd/environment, cancellation and joined process trees. Large image replies are exercised through the configured wire connection. |
| Windows computer and terminal windows | Native window identity, screenshots/PNG, fresh single-use observations, input/clipboard, owned application windows and console process jobs. Project-mode restrictions and device-mode authorization remain distinct. |
| Recovery and host control | `!recover` claims/cancels the exact target before the Windows handoff; package-bound recovery scripts reinspect retained process identities. `!repair`, host controls and supervisor commands are wired. `!open` selects/resumes a conversation, matching Rust. |
| Watchdog/startup | `--watchdog`, `--start`, logon task install/remove, status and generation-bound control requests. Graceful restart drains without automatic force escalation; explicit force owns the exact Job Object. Crash retry, output and log retention are bounded. |
| Archive deletion | Verified backup, exact metadata/transcript checks, SQLite deletion, index update, exact rollout deletion, mirror cleanup and durable fence completion. Uncertain stages retain backup/evidence. |
| Administration | Thread list/archive, attachment send, configuration/setup, plugin verification, backup, read-only recovery/lifecycle inspection, intake retirement, saved-final authorization and mirror-cursor migration. No synthetic Discord ingress grants local CLI authority. |
| Resources and paths | Native CPU/RAM/disk observations, Korean/Unicode filenames, long local paths and 92 pinned Rust Windows-path oracle vectors. |

## Correctness fixes found by concurrent application testing

A three-thread application fixture exposed two real composition defects:
global native worker capacity saturation could fail an otherwise valid request,
and a single busy flag in the idle-before-start adapter rejected different
threads. The installed application now waits in finite pre-submission queues,
and the idle adapter tracks separate exact targets. Original deadlines include
waiting time. Cancellation removes only an unstarted waiter; an admitted worker
must still exit before its resources are released.

The fixture completes three threads over three rounds, interrupts one additional
turn with stop, then receives the next request's final answer. It verifies ten
successful final deliveries, no replay, real child/worker exit, and reacquisition
of the runtime singleton. This is a short concurrent regression run, not a
multi-day production soak.

The configured remote integration also caught mutable native result objects:
a successful file mutation could otherwise fail result validation and quarantine
the session. Native results are now frozen before entering the dispatcher.
An expected-hash mismatch established before a write returns a settled conflict
and leaves the session usable; an unknown post-effect failure remains held.

## Verification

Tests use loopback HTTP/WebSocket services, inert local provider fixtures and
temporary databases. They do not contact Discord or run a model. Native tests
exercise Windows handles, mutexes, SQLite, Job Objects, DPAPI and real worker exit.

| Check | Evidence |
| --- | --- |
| Type checking | PASS; `.runtime/typecheck-package-final.log`. Installed test compilation also type-checks the changed graph. |
| Default npm suite | **117 tests: 115 passed, 2 platform skips, 0 failed**; `.runtime/full-npm-final.log`. Includes concurrent application/final/stop tests. |
| Native worker profile | **361/361 passed**; `.runtime/full-workers-final.log`. |
| Migration profile | **664/664 passed**; `.runtime/full-features-migration.log`. This broad run preceded the final concurrency and package-path changes; affected worker/application/Pro paths were checked separately afterward. |
| Feature profile | **70 tests: 69 passed, 1 POSIX-only skip, 0 failed**; `.runtime/features-package-final.log`. |
| Remote regression | **78/78 passed** after the configured result-size change; `.runtime/remote-regression-final.log`. |
| Package-path / bootstrap follow-up | **25/25 passed**; `.runtime/pro-package-corrected-final.log`. Two existing fixtures had supplied a POSIX recovery platform with Windows drive paths; the fixtures now select their actual platform. |
| Installed npm package | **38/38 passed**; `.runtime/npm-installed-release-final.log`. Consumer installation uses `--ignore-scripts`, production dependencies only and `--no-strip-types`, with test code redirected to the installed `dist` graph. |
| Installed CLI and PowerShell smoke | npm-generated `.cmd` version/help/config checks pass without token disclosure. The default-root PowerShell smoke passes in an installation with no test sources; `.runtime/npm-installed-ps-final.log`. |
| Recovery/task safety | Eight PowerShell assets parse; scheduled-task arguments are checked without registering a real task. Fixture supervisor drains, force-restarts and stops its owned child only. |
| Packaging | 1,074 tarball entries, including 24 plugin files and 5 scripts. No raw source TS, tests, credentials, databases, logs or runtime caches. |

The table lists overlapping suites; their counts must not be added into a claim
of unique tests. Logs retain initial failures and corrected reruns separately.
The archive failure fixture now accepts either the native observation deadline
or the outer persistence deadline, and in both cases checks the same retained
fences, unchanged selection and joined provider. The installed PowerShell smoke
also caught a default parameter evaluation issue; root resolution now runs in
the script body, after PowerShell has initialized its script directory.

The installed application fixture measured **6.65 seconds** from prompt submission
to final delivery with a 100 ms provider response, so several seconds of bridge
overhead remain. The installed three-thread/repeated/stop run peaked around
**290 MiB RSS** and shut down in **0.24 seconds** on this machine. These are local fixture measurements,
not live-service latency promises.

## Install and operate

Final artifact: `codex-discord-bridge-ts-0.1.0-alpha.2.tgz` (1,395,793 bytes).
SHA-256: `9fdaa0cb397ba3504916cb38bff0c59c9a75bc2c6cd5f60e56bfc60ca2470895`.

Use Node **>=24.21.0 <25**. The system's older Node installation was not replaced.

```powershell
npm install --global --ignore-scripts .\codex-discord-bridge-ts-0.1.0-alpha.2.tgz
codex-discord-bridge --version

# Prepare .env in a separate runtime directory.
cd C:\codex-discord
codex-discord-bridge --check-config
codex-discord-bridge --start --runtime-root C:\codex-discord
```

`--start` runs the watchdog in the foreground and clears an explicit stop marker.
From another terminal, `--install-startup --runtime-root C:\codex-discord`
registers logon startup. `--watchdog` honors an existing stop marker.
Stop a prior runtime/watchdog before choosing the same root for this installation.

For existing legacy mirror cursors, after stopping the old runtime:

```powershell
codex-discord-bridge --admin migrate-mirror-cursors --repo-root C:\codex-discord
```

Only then enable `DISCORD_SESSION_MIRROR=1` for that migrated store. Migration
does not replay requests or infer historical delivery. An installation with no
legacy cursors can initialize its verified mirror directly.

To reproduce installed-package verification from the development checkout:

```powershell
node tools/test-installed-package.mjs <path-to-alpha.2.tgz>
```

## Qualification boundaries and finite limits

- Interactive screenshots/input, the real remote service, real Discord delivery,
  live Desktop recovery and actual logon-task behavior still require deployment
  qualification. The implementation exists; fixture coverage is not a claim
  that those live actions were performed.
- Runtime roots must be local drives. UNC runtime singleton safety, ARM64 and
  non-Windows runtime behavior have not been qualified by this Windows x64 run.
- Native active-worker budget stays at eight. Installed admission queue limits
  are Background 16, Control 8, Observation 8, Discovery 2 and Maintenance 2.
  Owned Control/Observation completion queues retain priority and their own
  finite limits.
- Remote incoming requests retain the TS aggregate 4 MiB admission bound and
  conservative internal string charging. Configured outgoing results allow up
  to 12 MiB. Images are limited to 5 MiB, checkpoint mutation data to 20 MiB,
  checkpoint retention to 500 records/512 MiB, terminal sessions to 32 and
  terminal windows to 8. These guards mean behavioral coverage does not claim
  byte-for-byte capacity equivalence to Rust.
- The experimental persistent-store receiver is not selected by the installed
  runtime. Exact pre-admission cleanup/protocol regressions were fixed, but its
  separate negative qualification fixture remains intentional. It is not needed
  for the installed per-operation-worker runtime and is not presented as a
  completed persistent-worker performance optimization.
- The delivered file is an npm-installable prerelease tarball. It has not been
  published to the npm registry or merged to main.
