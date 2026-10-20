# Upstream independent desktop tools delta

Status: inspected upstream change; TypeScript parity is NOT implemented or verified.

Comparison: 3ebf4223b75b9d36237a73a78ce52ce794aee4ca through d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34.
https://github.com/simdorei/codex-discord-remote-rust/pull/6

The GitHub comparison was read on 2026-10-13. It contains 11 changed files and three commits.
Keep phase-one source authority pinned; this is an explicit later delta, not a retroactive baseline replacement.

## Required parity work

- Windows AppServerConfig default arguments add the independent native-pipe option.
- Windows inherited environment excludes the seven desktop-owned identity/pipe variables; explicit caller overrides remain possible. Preserve authentication and CODEX_HOME.
- Initialize advertises mcpServerOpenaiFormElicitation.
- After original request authority validation, only node_repl computer-use/browser low-risk form/openai-form requests with the exact empty approval schema receive an acceptance response.
- Unknown/elevated/data-entry form requests are cancelled; non-form methods retain existing handling.
- Response must remain bound to the exact original occurrence and resident generation. Never introduce a persistent grant or replay.

## Current TS evidence

src/app-server/startup-handshake.ts currently advertises experimentalApi only.
src/runtime/server-request-delivery.ts validates original prompt authority, but the new local-tools branch is not present.
The existing response-attempt machinery binds original occurrence, parameters and durable authority; reuse requires explicit integration tests rather than substituting an unguarded response.

## Qualification before applying

Read complete immutable changed Rust sources and tests, then cover accepted empty schema, rejected unknown keys/fields, raised risk, URL/non-form behavior, stale occurrence/generation/owner, failed authority, explicit Windows environment overrides, and non-Windows behavior.
A Linux test is not Windows native-tool qualification. Upstream CI and live-tool reports are not TS parity or deployment approval.
