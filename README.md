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
npm install --global --ignore-scripts .\codex-discord-bridge-ts-0.1.0-alpha.8.tgz
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
and general text channel ID (`DISCORD_ALLOWED_CHANNEL_IDS`). User IDs are optional.
Fresh installation defaults match Rust: session mirroring and startup notices
are enabled, and history polling runs every 15 seconds. Codex must already be
installed and authenticated. `DISCORD_GUILD_ID` is optional: mirror sync can
resolve the server from the command channel. Category, project channel and
conversation thread IDs are created/recorded by the bot; do not prepopulate them
in the command channel allowlist. The bot must have the channel/thread and
message permissions needed for these operations.
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
consumed prefix. Independent targets deliver concurrently under shared mapping
ownership. Unchanged file generations reuse verified SHA state; a changed file
or a process restart requires prefix verification again. Files above 512 MiB
are supported within the verification deadline. For a Rust/older TS store, stop its runtime and watchdog, then
explicitly migrate existing cursors before enabling `DISCORD_SESSION_MIRROR=1`:

```powershell
codex-discord-bridge --admin migrate-mirror-cursors --repo-root C:\codex-discord
```

This command acquires runtime exclusion, backs up the store and preserves each
cursor and turn. Changed/uncertain sources are reported as held. It does not
replay old requests or assert that historical messages were delivered.

The alpha.5 template incorrectly disabled mirroring and omitted startup notices.
For a new installation configured from that template, run the packaged
`scripts/Restore-RustDefaults.ps1 -RuntimeRoot C:\codex-discord`. This explicitly
restores those two settings, keeps a byte-for-byte local `.env` backup and
preserves credentials, IDs, paths and other preferences. It does not start or
restart a bot. Run `--check-config` and restart the configured runtime afterwards.
For an imported Rust/older TS store, complete the cursor migration above before
enabling mirroring; this configuration repair does not migrate databases.

## Watchdog and startup

```powershell
codex-discord-bridge --start --runtime-root C:\codex-discord
codex-discord-bridge --install-startup --runtime-root C:\codex-discord
codex-discord-bridge --supervisor-status --runtime-root C:\codex-discord
codex-discord-bridge --supervisor-control restart --runtime-root C:\codex-discord
codex-discord-bridge --supervisor-control stop --runtime-root C:\codex-discord
codex-discord-bridge --remove-startup --runtime-root C:\codex-discord
codex-discord-bridge --tray --runtime-root C:\codex-discord
```

The tray exposes status, logs, graceful restart and explicit force restart.
Closing the tray leaves the watchdog running. To install the bundled plugin into
the selected Codex profile, run this explicit local command:

```powershell
codex-discord-bridge --admin install-plugin --repo-root C:\codex-discord
```

Its packaged Pro helper runs with Node and preserves the existing conversation
SQLite format. It needs no `cdr-pro-helper.exe`. Plugin installation validates the
actual Codex marketplace and plugin inventory after registration. The helper's
`verify-cachebuster` and `collect-release-evidence` development commands require
`--repo-root` pointing to a built source checkout. Runtime conversation, probe
and hook commands work in a copied plugin without the source checkout.

`--start` runs the watchdog and clears an explicit stop marker. `--watchdog`
honors that marker, including on subsequent logons. Run installation in another
terminal while a foreground watchdog is running. The task uses the current
user's interactive logon at normal privileges. Graceful restart drains work;
`force_restart` cancels the exact owned process job. Control requests carry
runtime identity and expiry; `--expected-runtime ID` adds an explicit generation
check. Crash retries and logs are bounded. Do not leave a Rust watchdog active
for the same runtime root. Installation does not remove unrelated tasks.

Graceful restart accepts `--delay-seconds`, `--restart-quiet-seconds` and
`--restart-wait-timeout-seconds`. The supervisor continues receiving stop and
explicit force requests while waiting for the current runtime to drain. The
bundled `restart.ps1 -Immediate` requests graceful restart with no scheduling
delay; `-Force` explicitly selects cancellation. A drain timeout preserves its
state for inspection and never silently turns into a force restart.

To switch a recognized local Rust installation while retaining its runtime
directory and database, inspect the cutover inventory first:

```powershell
codex-discord-bridge --cutover-from-rust --runtime-root C:\codex-discord --legacy-binary C:\repos\codex-discord-remote-rust\target\release\cdr-runtime.exe --dry-run
# Repeat the same command without --dry-run to perform the switch.
codex-discord-bridge --recover-cutover --runtime-root C:\codex-discord
```

Cutover records progress, backs up the database, disables recognized Rust tasks,
stops the owned Rust process, verifies/migrates mirror cursors, installs the TS
logon watchdog and observes its heartbeat. Recovery stops and verifies the TS
runtime before restoring the source task configuration; it preserves the current
database rather than restoring an old snapshot. An unconfirmed stop leaves the
source fenced. The journal is `.cdr-ts-cutover.json` in the runtime root.
`--recover-cutover` explicitly rolls back that recorded switch, including a
completed one. Use the same installed Node/package paths for recovery.

Cutover recognizes literal legacy script/binary task actions bound to the supplied
paths. It is not a general task remover; custom encoded wrappers require separate
inspection. A running Rust source must have an originally enabled watchdog/runtime
task so rollback can start it independently of the cutover command's process job.
The native Task Scheduler transition, tray UI and reboot remain live
qualification items; automated tests cover phase failures and recovery boundaries.

`DISCORD_ENABLE_HOST_COMMANDS=1` enables host controls. `!repair` resets idle
tool sessions; `!recover` cancels the target's requests and dispatches the
Windows Desktop/bot recovery handoff. It never automatically resends a prompt.
`!open` resumes/selects a conversation, matching the Rust command.
The Stop worker gives verification, claiming and interrupt dispatch separate
two-second cooperative budgets. A slow verification no longer consumes the
interrupt's remaining time after its durable claim. Each polling cycle attempts
one claim before yielding; shutdown cancellation and unknown-outcome holds remain.

## Remote and administration

Existing `CODEX_REMOTE_MCP_*` configuration connects the native remote agent to
the configured service. Non-loopback connections require WSS. Project roots,
session generations, observation identities and deadlines bound operations.
Restart bindings are protected with current-user Windows DPAPI, expire and can
be claimed once. File changes use expected hashes and durable checkpoints;
Git and terminal operations have bounded output and owned process lifetimes.
Project-mode computer control owns its launched windows; device-mode access
requires the corresponding existing service authorization.

The package also supplies a standalone `cdr-mcp-server` with the Rust gateway's
OAuth storage layout, 51 MCP tools and protocol-10 PC bridge. The server reads
environment variables directly (it does not load the bot's `.env`). Configure:

```powershell
$env:SIMDOREI_MCP_PUBLIC_BASE_URL = 'https://gateway.example.com'
$env:SIMDOREI_MCP_BIND = '127.0.0.1:8030'
$env:SIMDOREI_MCP_OAUTH_DATABASE_PATH = 'C:\codex-gateway\oauth.sqlite3'
$env:SIMDOREI_MCP_OWNER_TOKEN = '<owner approval secret: at least 24 bytes>'
$env:SIMDOREI_MCP_DEVICE_ID = 'pc-1'
$env:SIMDOREI_MCP_DEVICE_TOKEN = '<device secret: 32 to 512 printable ASCII characters>'
cdr-mcp-server --check-config
cdr-mcp-server
```

For multiple PCs, use `SIMDOREI_MCP_DEVICE_CREDENTIALS_JSON` with
`{"version":1,"devices":[{"device_id":"pc-1","token":"..."}]}`; credentials must
be unique. Create the database directory before startup. The public base must be
an HTTP(S) origin without a path. For remote use, terminate HTTPS/WSS at the public
endpoint and forward `/mcp`, `/bridge`, OAuth endpoints and discovery metadata to
the local listener. This command does not provision TLS, DNS or a tunnel.

The HTTP transport returns JSON responses and does not expose a GET SSE stream.
OAuth SQLite work runs in a bounded worker; independent bridge requests can finish
out of order. A dropped HTTP connection never replays or cancels admitted work.
Live connector attachment and server deployment are separate qualification steps.

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
node tools/test-installed-package.mjs .\codex-discord-bridge-ts-0.1.0-alpha.8.tgz
```

Tests exercise actual Windows file handles, SQLite, mutexes, Job Objects,
DPAPI and worker exit. Application fixtures cover three concurrent threads,
repeated final delivery, stop and a subsequent request without replay. No tests
send real Discord messages, run a model, reboot the PC, recover the user's live
Desktop or register a real startup task. Interactive input/capture and the live
remote service still need deployment qualification. ARM64 and non-Windows
runtime behavior are not qualified by Windows x64 results.

Alpha.3's fixes and remaining limits are recorded in
`docs/rust-ts-feature-gap-fixes-20261018.md`. In particular, unchanged mirror files
reuse their verified prefix, but an append/change or restart still requires full
prefix verification. This is not yet a persistent incremental continuity protocol.

The installed runtime reuses bounded native workers for registered database and
file operations. Bridge state has a separate serialized lane, and the existing
ownership, cancellation and native-exit checks remain enforced. Operations that
are not registered for reuse retain their per-operation worker lifetime.
The experimental persistent-store receiver is not selected by installation;
its negative probes are not a throughput qualification. See
[the migration report](https://github.com/simdorei/codex-discord-bridge-ts/blob/codex/ts-npm-windows-20261018/docs/npm-windows-migration-checkpoint-20261018.md)
for the implementation matrix and verification evidence.
