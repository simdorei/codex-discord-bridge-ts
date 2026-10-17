# Codex Discord Bridge (TypeScript migration)

Migration from `simdorei/codex-discord-remote-rust`, based on remote branch
`sss/async-admission-cloud` at `4c2f0e1e62829e15f274858c6b41a28066212d86`.

This is an **alpha migration build** with an installable npm launcher and a
Windows local runtime. Native integration tests cover command intake, app-server
execution, final delivery, shutdown, process-tree cleanup, and Unicode/long paths.
Full Rust parity is unfinished: CLI session mirroring, configured remote MCP,
desktop recovery/restart controllers, archive deletion, persistent-resident
failure cleanup and live cutover remain outstanding. Do not run it against a
store owned by another bridge instance.

## Build and install

Use Node.js **24.21 or later within major 24**, including npm. Rust/Cargo and a
global TypeScript installation are not required. Koffi supplies the Windows
native binding through its platform prebuilt package.

```powershell
npm ci
npm run typecheck
npm test
npm pack
npm install --global --ignore-scripts .\codex-discord-bridge-ts-0.1.0-alpha.1.tgz
codex-discord-bridge --version
```

For a supplied `.tgz`, only the final two commands are needed. Installing the
tarball does not compile TypeScript or Rust. Windows x64 is tested on this PC;
ARM64 bindings exist but have not been exercised on ARM64 hardware.
The tarball and Koffi platform dependency are already built; `--ignore-scripts`
keeps installation independent of source-build lifecycle scripts.

The installed package contains compiled JavaScript, workers, the launcher and
documentation. Tests, development tools, local databases, logs and credentials
are excluded. The package is not yet published to the npm registry.

## Configure and run

Create a separate runtime directory, copy `.env.example` to `.env` there, and
set the bot token and allowed channel IDs. Existing Rust environment variable
names are preserved. The npm command reads `.env` from the **current directory**;
`--env <path>` explicitly selects another file. Keep `DISCORD_SESSION_MIRROR=0`
for the currently connected local profile. Unsupported settings fail explicitly.
Use an absolute local drive path for `CODEX_DISCORD_ROOT`; UNC runtime roots are
not supported by this alpha. Existing Codex application installations missing
their matching `codex-code-mode-host.exe` are skipped for a complete older pair.

```powershell
cd C:\codex-discord
codex-discord-bridge --check-config
codex-discord-bridge
```

Codex must already be installed and authenticated. `CODEX_EXE`, `CODEX_HOME` and
`CODEX_DISCORD_ROOT` are optional overrides; otherwise the existing discovery and
current-directory runtime layout apply. No credentials are needed for `--help`
or `--version`. Installing the package never starts a bot or changes a watchdog.

## Validation

`npm test` builds the production and compiled test graphs, then runs the focused
npm/Windows integration selection. Windows native cases run only on Windows;
non-Windows factory-refusal cases run on other platforms. This selection is not
the full historical migration suite. Select additional existing tests explicitly:

```powershell
npm test -- test/cli/startup.test.ts
npm run test:migration
node tools/run-tests.mjs --profile windows-workers
```

The migration profile checks native database actions, stop/recovery receipts,
mirror synchronization, attachment paths and executable fallback. The workers
profile checks the narrowed worker imports and cancellation/ownership behavior.
The full application test uses loopback Discord HTTP/WebSocket fixtures and a
local synthetic app-server; it never sends real Discord messages. This is not a
live-service or multi-thread load qualification.

The original migration evidence and outstanding gates remain in `docs/`.
See `docs/npm-windows-migration-checkpoint-20261018.md` in the source repository
for scope, verification, and the next integration steps.
