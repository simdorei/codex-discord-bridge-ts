# Checkpoint 865: WIP local runtime entry composition

Archived 2026-10-14 UTC. This is an experimental candidate, not migration completion or runtime acceptance.

Scope: package script runtime:local, compiled local CLI, local application composition, and six local CLI tests. The application composes path discovery, POSIX singleton acquisition, resident preparation, paused gateway, workers, and joined shutdown. Remote MCP, session mirror, host commands, and Windows profiles are explicitly rejected.

Verification on the archived candidate: TypeScript noEmit and compiled test graph build succeeded. Compiled local CLI plus maintenance CLI: 11 passed, zero failed/cancelled/skipped. These cover offline CLI branches only; they do not execute a complete live runtime.

Unverified: successful full startup and shutdown, live Discord/Codex integration, active-lifetime cleanup failures, performance and long-running acceptance. POSIX singleton integration previously encountered Unix socket listen EPERM in this environment; this checkpoint does not resolve or qualify it. Windows, remote and session-mirror parity remain incomplete. Protected redaction fixture is excluded and is not counted as passed or skipped.

No deployment, main merge, or production restart is authorized by this checkpoint. No real credentials, DBs, raw logs, or protected fixtures are part of this archive.
