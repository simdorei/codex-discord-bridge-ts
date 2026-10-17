# Explicit POSIX ciphertext handoff in the synthetic runtime (921)

This installs the [920 POSIX persistence slice](remote-restart-handoff-persistence.md) as an explicit option in the existing [912 synthetic runtime profile](synthetic-remote-runtime.md). The same [911 managed owner](managed-remote-ownership.md), dispatcher, connection loop, monitored task and runtime shutdown custody remain responsible for the lifetime. There is no replacement lifecycle, queue, replay mechanism, native-backend authority or default CLI installation.

## Explicit option and passive capture

`createSyntheticRuntimeRemoteProfile` accepts the existing `SyntheticProtectedBindingPorts` fixture or this exact handoff record:

```ts
handoff: {
  kind: 'PosixCiphertextRestartHandoff',
  path: '/explicit/disposable/location/handoff.json',
  resumeRequested: true,
  protector: {protect, unprotect},
}
```

All four fields are mandatory. The path must be an explicit absolute, bounded, well-formed POSIX string. The option and protector must be passive exact records. Both protection callbacks are captured, detached and retained before any asynchronous work; accessors, proxies, unexpected fields and unsupported callbacks are rejected without invoking them. The caller explicitly supplies a trusted authenticated protector. No provider, platform/current-user key protection, key discovery, plaintext fallback, default storage path, environment lookup or credentials are supplied or qualified.

Profile creation captures only. It performs no filesystem work, clock call, project open, protection call or socket operation, including when resume is requested. Later changes to caller objects cannot retarget the path, resume choice, protector, socket identity or clock function. The existing profile/context receipts and single-use rules remain intact.

The handoff binding is derived from the profile's captured socket `bridgeUrl` and `deviceId`; the clock is the exact captured `dispatcher.nowUtc` function. The option accepts no independent binding or clock fields. The new variant requires the supplied URL spelling to equal `new URL(bridgeUrl).href`, as well as the existing `ws:` IPv4 loopback, explicit nonzero/nondefault port, no credentials and no fragment restrictions. Thus a URL such as `ws://127.0.0.1:1234/` qualifies, while its missing-slash, numeric-host-alias or whitespace-normalized equivalents do not. Input is rejected rather than silently rewritten. This is an explicit WHATWG canonical-spelling restriction, not a claim that all URL path/query components serialize identically in Rust. Existing fixture URL behavior is unchanged.

## Startup consumption

After the same exact Pro/executor preparation and before gateway construction, the existing managed restore calls the adapter once. `resumeRequested: false` returns empty without filesystem/protector work or a handoff clock read. For `true`, the adapter captures one validated timestamp from the same dispatcher clock and awaits the actual 920 claim:

1. Rename the pathname into a unique owned claim.
2. Read the bounded protected envelope, authenticate/decrypt it and validate the entire payload, fingerprint, protocol, resume window and project expiries.
3. Canonicalize every project root and require directories.
4. Remove the claimed pathname before exposing any restored vector.

No project opens, gateway or remote dial precedes successful completion of those stages. The reader's full error precedence and newer-publication preservation remain unchanged. Abort does not race claim work or treat signal delivery as completion: managed startup checks cancellation only after the actual restore promise settles, and then joins any acquired project cleanup through its existing owner.

The persistence codec permits 128 projects and duplicate IDs. The managed boundary remains stricter: at most 16 projects, no duplicate IDs, 4,096 units for identity/root text and its existing immutable DTO aggregate budget. A valid encrypted file can therefore be consumed and removed successfully, then rejected by managed validation before any project opens. Such rejection does not republish or retry the file. Restored data is only `threadId`, canonical `root` and `expiresAt`; session IDs, caches, generations, commands and uncertain effects are not restored.

## Shutdown publication and completion

The existing runtime samples its owned restart markers with explicit-stop precedence before requesting remote stop. Its sticky control is sampled by the same managed owner only after the loop has joined accepted commands, session cleanup and socket disposal. A request during actual drain counts; a request after the decision cannot retroactively publish.

The dispatcher exports its existing sorted, unexpired binding-only snapshot. Final project cleanup then completes before protection or publication can begin. Failed cleanup retains the existing authentic managed/runtime owners and prevents handoff publication. Following successful cleanup, the owner samples the captured clock once, re-filters bindings with that exact timestamp and passes the same immutable timestamp into the 920 writer. The writer does not resample the clock for `created_at` or its 120-second resume deadline. A slow protector or filesystem operation does not extend that timestamp/window.

Normal stop, abandoned preparation, empty snapshots and bindings expired during project cleanup do not publish. The legacy fixture's void completion remains supported. The concrete adapter validates and forwards the writer's boolean, and `handoffPrepared` becomes true only for actual success. A false result remains false. Malformed completion values fail rather than manufacturing success.

The existing managed completion receipt includes protection, temporary-file write/fsync/close and final atomic rename. Stop/force requests and repeated close do not release the owner early, rerun the writer, retry a failed operation or turn uncertain completion into replay. Protection/publication failures propagate after confirmed project cleanup; the existing monitor and runtime release rules distinguish an ordinary failed outcome from retained resources.

## Source authority and qualification

Read-only assessment reverified the existing ordering at Rust commit `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`: [runner.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/runner.rs), blob `a711839bd0c467058f7aed0c02f30c9794f94006`, and [restart_handoff/lifecycle.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/restart_handoff/lifecycle.rs), blob `a90123390f77667dd5a5e107aa73b892676cff8f`. The persistence model/validation/storage and runtime startup/shutdown authorities remain those recorded in 911/912/920. This adds no new Rust oracle or fresh provider qualification. Existing 917–920 evidence is historical and unchanged.

The 920 limits remain: POSIX namespace replacement and file fsync without parent-directory durability; pathname consumption rather than global replay prevention; no hostile ancestor/symlink race containment, stale-claim scavenger or automatic cleanup retry. Current-user protection, native Windows storage, real project/session backends, production remote authorization and live-provider behavior remain unqualified. Tests use fresh in-memory AES-256-GCM keys and disposable files only.

The CLI/default configured-remote and platform gates are unchanged. The synthetic root tests retain the explicitly fake singleton seam; they do not qualify UNIX listener exclusion, retry a denied UNIX bind or substitute TCP for it. Inactive 893 remains inactive. The separately denied 913 native-read review is neither inspected nor qualified. Reserved Windows paths are excluded.

## Selected verification

Verification uses pinned Node 24.21.0 and TypeScript 7.0.2, explicit selected roots plus their static dependencies and literal worker URLs, private emitted JavaScript and `--no-strip-types`. A deny predicate guards source access before traversal. It excludes the protected redaction test, every remote-agent native-read path and reserved Windows directories. No broad build/test entrypoint is used. Actual compiler file lists must equal the selected graph, and a separate production-only build must byte-match production output in the selected test build.

Focused tests exercise the concrete adapter and existing runtime owners using real encrypted temporary files, ephemeral authenticated protection, two lifetimes, capture/clock boundaries, consumed-vector rejection, actual held startup/shutdown stages and failure precedence. Exact final counts, immutable file hashes and commands are recorded in the checkpoint's scoped verification receipt. This is a selected synthetic integration result, not full-repository, production-platform, current-user-protector or performance qualification.
