# Synthetic remote runtime installation (912)

This slice installs the 910 dispatcher and 911 managed owner into the prepared runtime, through an explicit programmatic synthetic profile. It is qualified only by synthetic resources and actual loopback sockets. It does not enable configured remote MCP in the CLI or default application, and it is not production, Windows, protected-persistence or native-backend qualification.

## Source authority

Source ordering was verified read-only at `simdorei/codex-discord-remote-rust`, commit `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`:

- [discord_runtime.rs, startup order](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/discord_runtime.rs#L99-L184), blob `43c4e0376df47ae4571c19b66b6678c49928cec1`
- [discord_runtime/workers.rs, prepared remote and monitored start](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/discord_runtime/workers.rs#L37-L70), blob `952d5e739dc887481afbf740dd2078947ed2e72d`
- [discord_runtime.rs, pre-stop handoff and joined shutdown](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-runtime/src/discord_runtime.rs#L261-L286)
- [runner.rs, same dispatcher, reconnect and post-loop handoff decision](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-remote-agent/src/runner.rs#L15-L163), blob `a711839bd0c467058f7aed0c02f30c9794f94006`

The remote worker source and managed runner match the frozen `4e213aa69dc89bed1552d8b83e12471d7664b7ae` authority. The runtime root's difference concerns startup resume recovery, not the remote ordering used here. Final wire/schema authority and inactive 893 are unchanged.

## Explicit preparation and ownership

`createSyntheticRuntimeRemoteProfile` captures a `ws:` endpoint whose parsed hostname normalizes to `127.0.0.1` with an explicit nonzero port, an explicit `synthetic-` token and typed synthetic ports. It allocates fresh private shared status/control, but opens no project or socket and reads no environment or credential source. Inputs are passively captured without accessor/proxy execution. Private managed/dispatcher callback receivers remain undefined. The synthetic profile is an authentic WeakMap receipt, not a user assertion of native qualification.

`prepareRuntimeProContext` consumes that profile once and installs its exact device ID and shared readiness closure before Pro capture. It refuses an unrelated preconfigured Pro readiness callback. Only the returned exact context can prepare the remote. The context binding retains its root and admission identity; disposed, disposal-in-progress, copied, proxied, foreign and reused contexts/profiles are rejected. A context disposed during asynchronous restore causes joined remote cleanup before preparation rejects.

`prepareSyntheticRuntimeRemote` restores one 911 managed owner after executor preparation and before gateway construction. Preparation cannot dial. Failed restore joins previously accepted project cleanup; failed cleanup retains the underlying authentic owner. The same prepared receipt is tied to the exact context and gate and can be transferred to runtime workers only once. The existing 911 dispatcher and managed loop own all connection/session/cache authority across reconnects. No new command queue, pool or execution callback is introduced.

The application accepts this profile only as an explicit optional programmatic argument. `config.remoteMcp !== null` remains rejected even when a synthetic profile is supplied; the CLI supplies no profile. The default disabled branch allocates no remote status/control, dispatcher, marker store, task or socket, and invokes no remote callback.

## Startup and joined shutdown

Prepared worker options now require `DisabledRemote` or an authentic prepared synthetic receipt. Exactly one `remote-mcp` monitored task starts after typed ingress and interaction, before app-server supervisor, heartbeat and completion. It is present in the normal worker vector, startup trace and exit monitor, and absent from the heartbeat owner.

Task allocation is synchronously reserved, so same-tick repeated start cannot create a second task. Closing after transfer cannot race the scheduled callback. A narrow monitored-worker abandoned-owner hook joins prepared cleanup if cancellation happens before callback entry; join and monitor closure cannot falsely report completion while that cleanup is pending. Construction failure, typed/interaction/core partial startup and pre-gateway failure also retain and join the exact prepared or active owner.

The remote's active stop signal is separate from user/startup cancellation. Once a shutdown cause is selected, the lifetime reads its bound root `PosixDrainMarkerStore.restartRequested()` under the original absolute shutdown deadline, with explicit-stop precedence. It sets the same sticky control before the first remote stop request. Thus a user abort cannot race ahead of the handoff decision. A request arriving during actual command/session drain is still observed by the 911 post-loop decision.

Remote exit and protection failure retain their actual monitored outcome. Every accepted remote command, session retirement, socket disposal and final project cleanup must join. After worker joins, a remote resource-release assertion precedes native resident disposal. Failed remote cleanup withholds resident and outer-release authority. Timeout/force requests never substitute for actual completion. The application keeps its singleton and runtime owners when cleanup is unconfirmed; successful outer cleanup closes HTTP and removes drain identity before releasing the singleton.

After drained restart selection, the same owned marker is read again, preserving source stop precedence. This is already after remote completion. It may set the sticky flag, but cannot rerun the managed owner or fabricate persistence. The TS marker read is asynchronous, so its actual settlement shares the existing final one-second heartbeat reserve; timeout is fail-stop and does not authorize outer release. No new shutdown deadline is invented.

## Qualification limits

- `SyntheticProtectedBindingPorts` remains a fixture boundary. There is no native encryption, durable handoff, fingerprint/envelope/resume-window validation, claim-by-rename, Windows protection or plaintext fallback.
- Real filesystem/write/checkpoint/Git/code/image/command, terminal and computer/UI backends, binding authorization and physical-resource qualification remain unfinished.
- Shared Pro readiness is a hello-ACK diagnostic, not session authority or final-wire authorization.
- The actual root composition tests use a deliberately synthetic singleton acquisition/release seam. They prove ordering and non-release while accepted work is held; they do not claim native UNIX socket acquisition/exclusion. The known UNIX-root EPERM case is not retried.
- Caller-provided synthetic ports must own partial initialization and settle actual work. Tests do not certify arbitrary callback implementations, exactly-once behavior or durable replay exclusion.
- Tests use emitted JavaScript and native emitted workers on pinned Node 24.21.0 with `--no-strip-types`. The protected test is excluded by exact private compiler path and is never read, compiled, run or reconstructed. Focused and bounded affected results are recorded separately and are not a full-suite PASS.

Final focused verification: **53 tests across 5 files passed**. The bounded affected run and an independent rerun each passed **351 tests across 36 files**, with zero failures/cancellations/skips. These overlapping selections are not a full-suite result. Protected-excluded strict TypeScript and the production build exited 0; all **957 production modules** byte-match the emitted test graph. Independent review also verified strict checking, production parity and the unchanged protected-excluded source graph. Exact frozen file hashes and verification receipts accompany checkpoint 912.

The subsequent [913 native read-only backend](native-remote-read-backend.md) can supply actual pre-bound POSIX read/list capabilities to the typed dispatcher. It does not promote this synthetic profile, enable the CLI remote branch or qualify the missing protected-persistence/native mutation and session backends.
