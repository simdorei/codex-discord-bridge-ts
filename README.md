# Codex Discord Bridge (TypeScript)

Windows/npm implementation of `simdorei/codex-discord-remote-rust`, continuing
remote TS branch `sss/async-admission-cloud` at
`4c2f0e1e62829e15f274858c6b41a28066212d86`. Rust reference:
`d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`.

The installed runtime includes Discord commands and attachments, durable queue
and final delivery, stop/recovery, automatic session mirroring, Pro/plugin
integration, configured remote MCP, project files/checkpoints/Git/terminals,
Windows computer controls, archive deletion, watchdog and logon startup.
This remains a prerelease: native tests use local providers and loopback servers;
live-service and interactive Desktop qualification are separate from implementation.

## Install

Use **Node.js >=24.21.0 <25** with npm on Windows x64. No Rust/Cargo or global
TypeScript compiler is needed to install the supplied compiled package:

```powershell
npm install --global --ignore-scripts .\codex-discord-bridge-ts-0.1.0-alpha.2.tgz
codex-discord-bridge --version
```

To build from this repository:

```powershell
npm ci
npm run typecheck
npm test
npm pack
```

Koffi uses its platform prebuilt dependency. The tarball includes JavaScript,
native worker modules, recovery scripts and plugin assets, excluding credentials,
databases, logs, tests and caches. No npm registry publication has been performed.
Installation alone does not start the bot or register a scheduled task.

## Configure and run

Copy `.env.example` to a separate runtime directory and set the Discord token
and allowed channel/user IDs. Codex must already be installed and authenticated.
Existing Rust environment names are preserved. The CLI reads `.env` from the
current directory; `--env PATH` selects another file. Use an absolute **local
drive** runtime root; a network/UNC root cannot provide cross-PC singleton safety.

```powershell
cd C:\codex-discord
codex-discord-bridge --check-config
codex-discord-bridge
```

`CODEX_EXE`, `CODEX_HOME` and `CODEX_DISCORD_ROOT` are optional overrides. Automatic
discovery skips an incomplete app installation lacking its matching
`codex-code-mode-host.exe` and selects an older complete installation. An invalid
explicit `CODEX_EXE` is reported instead of silently ignoring the override.

Automatic mirroring uses verified file identity and a hash of the entire
consumed prefix. For a Rust/older TS store, stop its runtime and watchdog, then
explicitly migrate existing cursors before enabling `DISCORD_SESSION_MIRROR=1`:

```powershell
codex-discord-bridge --admin migrate-mirror-cursors --repo-root C:\codex-discord
```

This command acquires runtime exclusion, backs up the store and preserves each
cursor and turn. Changed/uncertain sources are reported as held. It does not
replay old requests or assert that historical messages were delivered.

## Watchdog and startup

```powershell
codex-discord-bridge --start --runtime-root C:\codex-discord
codex-discord-bridge --install-startup --runtime-root C:\codex-discord
codex-discord-bridge --supervisor-status --runtime-root C:\codex-discord
codex-discord-bridge --supervisor-control restart --runtime-root C:\codex-discord
codex-discord-bridge --supervisor-control stop --runtime-root C:\codex-discord
codex-discord-bridge --remove-startup --runtime-root C:\codex-discord
```

`--start` runs the watchdog and clears an explicit stop marker. `--watchdog`
honors that marker, including on subsequent logons. Run installation in another
terminal while a foreground watchdog is running. The task uses the current
user's interactive logon at normal privileges. Graceful restart drains work;
`force_restart` cancels the exact owned process job. Control requests carry
runtime identity and expiry; `--expected-runtime ID` adds an explicit generation
check. Crash retries and logs are bounded. Do not leave a Rust watchdog active
for the same runtime root. Installation does not remove unrelated tasks.

`DISCORD_ENABLE_HOST_COMMANDS=1` enables host controls. `!repair` resets idle
tool sessions; `!recover` cancels the target's requests and dispatches the
Windows Desktop/bot recovery handoff. It never automatically resends a prompt.
`!open` resumes/selects a conversation, matching the Rust command.

## Remote and administration

Existing `CODEX_REMOTE_MCP_*` configuration connects the native remote agent to
the configured service. Non-loopback connections require WSS. Project roots,
session generations, observation identities and deadlines bound operations.
Restart bindings are protected with current-user Windows DPAPI, expire and can
be claimed once. File changes use expected hashes and durable checkpoints;
Git and terminal operations have bounded output and owned process lifetimes.
Project-mode computer control owns its launched windows; device-mode access
requires the corresponding existing service authorization.

`--help` lists local `--admin` operations, including thread list/archive,
attachment sending, saved-final authorization, read-only recovery inspection,
backup, plugin inventory verification and installation configuration. These
commands use the explicit local invocation as authority and do not fabricate
Discord ingress. Unknown mutation outcomes remain held for inspection.

## Validation and limits

```powershell
npm test
npm run test:features
npm run test:migration
node tools/run-tests.mjs --profile windows-workers
node tools/test-installed-package.mjs .\codex-discord-bridge-ts-0.1.0-alpha.2.tgz
```

Tests exercise actual Windows file handles, SQLite, mutexes, Job Objects,
DPAPI and worker exit. Application fixtures cover three concurrent threads,
repeated final delivery, stop and a subsequent request without replay. No tests
send real Discord messages, run a model, reboot the PC, recover the user's live
Desktop or register a real startup task. Interactive input/capture and the live
remote service still need deployment qualification. ARM64 and non-Windows
runtime behavior are not qualified by Windows x64 results.

The installed runtime keeps per-operation native workers. The experimental
persistent-store receiver is not selected by installation; its negative probes
are not a throughput qualification. See
[the migration report](https://github.com/simdorei/codex-discord-bridge-ts/blob/codex/ts-npm-windows-20261018/docs/npm-windows-migration-checkpoint-20261018.md)
for the implementation matrix and verification evidence.
