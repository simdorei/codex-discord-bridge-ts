# Rust installation defaults restored (2026-10-19)

The user's migration requirement includes the behavior after installation, not
only the defaults of `loadRuntimeConfig`. The alpha.5 `.env.example` violated
that requirement: it set `DISCORD_SESSION_MIRROR=0` and omitted
`DISCORD_STARTUP_NOTIFY=1`. The latter omission selected the runtime's `false`
fallback. Rust's installation template enables both.

The alpha.6 template enables both and explicitly carries the common Discord
defaults. All 15 shared, active template keys match the local Rust template.
History polling already defaulted to 15 seconds in both runtimes; spelling out
`DISCORD_HISTORY_POLL_SECONDS=15` restores configuration visibility, not a lost
runtime feature. Token and general text channel ID remain sufficient setup
inputs when Codex authentication and Discord permissions are ready. Both mirror
sync implementations can resolve an omitted guild ID from the command channel.

`scripts/Restore-RustDefaults.ps1` repairs the two settings in an existing
installation. It atomically replaces the UTF-8 file with an exact-byte backup,
preserves unrelated values, removes duplicate entries for the repaired keys,
does not log credentials and is idempotent. It does not start/stop the bot,
register tasks, touch databases or change existing cursor migration requirements.

The package version is alpha.6. The package ships the repair script and corrected
template; README installation steps and the installed-package test selection
include them. No runtime algorithm, authorization policy or source replay rule
was changed for this repair.

Validation artifacts are recorded with the distributed alpha.6 bundle. Focused
configuration/CLI/repair checks pass (28/28). An additional, unchanged mirror
profile fixture file has two pre-existing Windows failures: a POSIX absolute
path expectation and a symlink creation requiring unavailable privileges. These
are recorded separately and are not counted as passes or fixed by this patch.
The new PC's `.env` and running process remain outside this session's connection;
creating the repair artifact does not establish that it has been applied there.
