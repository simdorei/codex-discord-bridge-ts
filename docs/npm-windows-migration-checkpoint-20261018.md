# Windows/npm migration checkpoint — 2026-10-18

## Result and source identity

An installable **0.1.0-alpha.1** npm tarball now runs the Windows local runtime.
It is a migration checkpoint, not full Rust parity or approval to replace a live
bridge. The production bot, Discord credentials, live databases and watchdogs
were not changed by this work.

- Remote repository: `simdorei/codex-discord-bridge-ts`.
- Starting branch: `sss/async-admission-cloud`.
- Starting commit: `4c2f0e1e62829e15f274858c6b41a28066212d86`.
- Implementation branch: `codex/ts-npm-windows-20261018`.
- Rust reference: `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34` in
  `simdorei/codex-discord-remote-rust`; existing dirty Rust/local TS work was not
  reset or incorporated without review.
- Environment verified: Windows x64, Node **24.21.0**, Koffi **3.3.3**.

## Implemented

| Surface | Behavior in this checkpoint |
| --- | --- |
| npm entry point | Compiled JS and worker modules, `codex-discord-bridge` bin, version/help/config checks, current-directory `.env`, explicit `--env` override. |
| Windows runtime ownership | Rust-compatible named mutex, owned lock/heartbeat/drain markers, write-through atomic replacement, release only after joined owners. |
| App-server process | A Windows Job Object contains the fixed bootstrap, provider and descendants; parent death and disposal clean up the owned tree without PID-tree guessing. |
| Native SQLite actions | Windows guards lifted only for the tested queue/control/component/bridge/mirror paths; existing receipts, transaction boundaries, budgets and uncertain-outcome holds retained. |
| Paths | Windows lexical comparison, Rust workspace normalization, attachment filenames, Korean/Unicode and long local-drive paths; 92 Rust-oracle vectors and their pairwise equality matrix. |
| Executable discovery | Existing discovery/fallback retained and exercised: skip incomplete application installations and use an older complete `codex.exe`/`codex-code-mode-host.exe` pair. An invalid explicit `CODEX_EXE` remains an explicit error. |
| Resources | Worker-owned CPU sampling, physical RAM and caller-visible disk capacity, independent error reporting. |
| Worker startup cost | 19 hot-path modules now import the exact original store functions directly instead of loading the complete store facade. No SQL, replay, cancellation or ownership policy changed for this optimization. |

`DISCORD_SESSION_MIRROR=0` and host commands disabled are required by the current
CLI composition. Manual mirror synchronization and new-thread mirror-link
modules have separate fixture coverage; that does not install the automatic
session-log mirror producer.

## Verification

All network integration tests use literal loopback HTTP/WebSocket endpoints and
an inert local provider fixture. No test here sends a real Discord message or
calls a model. Tests exercise actual Windows mutexes, file replacement, SQLite,
process jobs and worker exit on this machine.

| Check | Result / evidence |
| --- | --- |
| `npm run typecheck` | PASS; `.runtime/final-typecheck.log`. |
| `npm test` after performance changes | 115 tests: 113 passed, 2 non-Windows-only cases skipped, 0 failed; `.runtime/npm-test-final.log`. |
| `npm run test:migration` | 39 suites / 664 tests passed; `.runtime/migration-test-final.log`. This broad run preceded the import-only optimization; affected stop-worker coverage was rerun in the worker profile. |
| `node tools/run-tests.mjs --profile windows-workers` | 43 suites / 361 cases: 360 passed initially, one existing POSIX-only symlink fixture failed with Windows `EPERM`. The fixture now uses a junction, a valid Windows filename and Windows lexical parent semantics. |
| Corrected fixture suite | All 11 cases passed; `.runtime/windows-worker-fixture-final.log`. The other 350 worker cases retain their matching passing execution; `.runtime/windows-workers-final.log`. |
| Resource worker registration | 17 resource/accounting cases passed after adding the resource worker to the closed read-only inventory; `.runtime/windows-resource-authority-final.log`. This includes the new enrolled-store regression added after the 115-case npm run. |
| Packed installation | Tarball installed with `--ignore-scripts` under a disposable npm prefix; all 5 installed application/resource tests passed, including final delivery and native cleanup; `.runtime/npm-installed-application.log`. The generated npm `.cmd` also passed version/help/current-directory config and token-redaction checks. |
| Package contents | Allowlist contains the launcher, compiled `dist/src`, manifest, README, `.env.example` and notices. No tests, raw TS, database, log, actual `.env`, credential or local runtime cache. |

The full application fixture emits its answer 100 ms after `turn/start`.
Measured prompt-to-HTTP-final time fell from **17.737 s to 5.796 s** in the local
test, with **0.251 s** shutdown; the installed package measured about **6 s**.
This is evidence of reduced local bridge overhead, not a model latency or
three-concurrent-thread throughput claim. Built-in Node compile caching was
benchmarked but did not materially improve worker startup and was not enabled.

## Install this checkpoint

Use Node.js **>=24.21.0 <25**. The system Node 24.13.1 on this PC is below the
qualified version; the launcher reports this clearly. Tests used the existing
isolated 24.21.0 runtime and did not change the system installation.

```powershell
npm install --global --ignore-scripts .\codex-discord-bridge-ts-0.1.0-alpha.1.tgz
codex-discord-bridge --version
# In a separate existing runtime directory, prepare .env from .env.example:
codex-discord-bridge --check-config
codex-discord-bridge
```

The tarball contains compiled JS and Koffi resolves its platform prebuilt
dependency. Consumer installation requires no Rust/Cargo or TypeScript compiler.
The npm registry package has not been published. Installing does not start a bot,
register a scheduled task or replace a running bridge.

## Remaining migration gates

| Gate | Concrete next work |
| --- | --- |
| CLI automatic session mirror | Bind a real producer and establish append-only cursor/source continuity. Do not manufacture the programmatic qualification assertions from a boolean environment flag. |
| Windows Pro / configured remote MCP | Finish Windows reparse-point validation, secret protection and the configured service/controller composition. Synthetic loopback profiles do not qualify real remote access. |
| `recover`, host restart and watchdog | Connect the actual Windows recovery controller, owned handoff, scheduled startup/watchdog replacement and cancellation evidence. Command parsing alone does not make these actions operational. |
| Desktop open and archive deletion | Install the remaining OS/controller adapters and exercise their failure paths before exposing the operations. |
| Persistent receiver | Resolve the pre-existing logical pending-request cleanup failures recorded in `migration-handover-stopped-20261017.md` and `persistent-receiver-pre-admission-probe-20261017.md`. The installed runtime currently keeps the existing one-operation worker ownership model. |
| Performance and release qualification | Further reduce the remaining several seconds of fixture overhead; measure three active threads, memory, restart/stop contention and a soak before live cutover. |
| Platform coverage | UNC runtime roots remain unsupported; ARM64 bindings and full non-Windows runtime behavior need their own hardware/CI evidence. |

None of these gates is bypassed to make installation look complete. This
checkpoint makes the npm/Windows execution path concrete and testable while
keeping the unfinished migration work visible.
