# Typed remote operation-error contract (916)

This is an offline, synthetic-fixture-qualified extension to the [910 dispatcher ownership foundation](remote-dispatcher-ownership.md). It adds typed error classification and result translation. It does not install or exercise a filesystem mutation, checkpoint, Git, command, image, terminal, process or UI backend. CLI enablement, authenticated bindings, protected handoff and operational remote qualification are unchanged. The 913 restricted WIP was not inspected, reviewed or activated.

## Source authority

Source authority is `simdorei/codex-discord-remote-rust` at `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`. These source files were read through the authorized GitHub connector and their captured bytes were checked against the exact Git blob IDs. Paths in the first ten rows are under `crates/cdr-remote-agent/src/`.

| Source | Git blob |
| --- | --- |
| `dispatcher/error.rs` | `25714cda9528a28dd5b57d3d81cd3ad4241ad6b1` |
| `dispatcher/execution.rs` | `ae0f9c51833dbd573855138d4b404d887995b637` |
| `dispatcher/execution/helpers.rs` | `f9c1c1bf1e2ac83d3fd15169dc8c14791ba9a87c` |
| `checkpoints.rs` | `da750f1b48597cd6b9f6df9965591c51ab0645cc` |
| `code.rs` | `af641fd5baf97b54ee36a722d367a2a28e104be5` |
| `commands.rs` | `ea1cae97f2ebadfbc7bd10807877476e31b86c47` |
| `git.rs` | `120cdbc297a6833ea831325990410eaec0dc1b34` |
| `images.rs` | `0a90231c8650cc3a26817599f05b895f25a07947` |
| `terminal.rs` | `e7ea3186a195d019ec12a5602b9a165db2a93104` |
| `commands/process.rs` | `b03ae2cad4fdcd2c03f302bbdd450735a86365d0` |
| `crates/cdr-core/src/deadline.rs` | `9a392cf6c966f76cbe5571049797f5c5407f7d6a` |
| `crates/cdr-remote-protocol/src/request/terminal.rs` | `c961ce7adf6760a129c6c91d709f4f54ce4bd2c4` |

The TypeScript starting point is local commit `34298f7177c9c4715bdb0207c9abd4411cbbf814`. Local and published histories remain distinct. No Git write or publication is part of this slice.

## Diagnostic contract and source routing

`RemoteOperationFailure` captures a validated family and source variant through passive own data fields. Its private identity record is authoritative; caller mutation, foreign exceptions, copied values, proxy wrappers and forged prototypes cannot supply typed semantics. Nested File variants require an authentic privately recorded `RemoteFileFailure`, rather than the tolerant existing file-rendering fallback. Nested Image/Checkpoint variants require an authentic checkpoint-family diagnostic.

The typed ports accept these families:

- WriteFile, FileCreate, FileApplyPatch, CheckpointList/Show/Restore: Checkpoint
- ProjectRules and CodeSearch: Code
- CommandList/Run: Command
- RepoStatus/Diff and GitCommit/Push: Git
- SaveImage, SaveImageFromUrl, ListImages and RetrieveImage: Image
- Terminal execution and terminal-window operations: Terminal
- ProjectStatus: Git, Code or Command. Its source Git → Code → Command execution order remains a backend obligation; the pure translator does not execute or reorder those stages.

Checkpoint and Git File variants use the source file code. Code File does likewise, while Code Cancelled produces the standard `request_cancelled` result. Image File delegates to file classification, Image Checkpoint delegates to checkpoint classification, and Image Cancelled produces `request_cancelled`. Other checkpoint, command, Git and image failures use `projectcheckpoint`, `projectcommand`, `projectgit` and `projectimage`, respectively. In particular, Command File remains `projectcommand` rather than inheriting a file code.

Every Terminal variant, including its Cancelled and Deadline variants, uses `terminal_execution`. The terminal shell diagnostic preserves Rust's `Powershell` Debug spelling. Source-specific prefixes and fixed messages are retained. Transparent JSON/base64/process/native/IO diagnostics are bounded strings supplied by a future qualified adapter; accepting those strings does not qualify native error production or platform-specific wording.

## Settlement, uncertainty and replay

A diagnostic alone says nothing about effects. `settledRemoteOperationFailure` creates a separate opaque returned receipt tied to the exact owned request object and an allowed family. The dispatcher consumes that receipt once, then maps it inside its guarded, awaited execution path. A trusted leaf may issue it only after all native work and effects have actually settled and been observed, just as the existing successful-return contract requires. This is an adapter assertion, not runtime proof of native settlement, rollback, physical-resource ownership or no effect.

Throwing or rejecting with a diagnostic, receipt or arbitrary exception never becomes a settled failure return. An exception after invoking a source-classified mutation preserves the existing uncertain-project barrier. Invalid output, a mismatched or reused receipt, or an awaited mapper failure also reaches that barrier. Reconnect does not clear it. Existing outer cancellation catches may return `request_cancelled` after the barrier is set; outward cancellation does not establish a definite effect outcome.

The mutation cache is unchanged and skips every `operation_error`. There is no automatic retry. A later explicitly submitted duplicate can execute again after an observed settled failure, just as existing cache error/non-retention behavior permits. This is not cached error replay protection, durable execution evidence or an exactly-once guarantee. `terminal_exec` retains the source's non-mutation/cache classification; that classification is not a statement that executing a terminal command has no effects.

Computer/UI ports, project/session creation failures, list/read exception mapping and the shared cache implementation are unchanged.

## Explicit TypeScript safety adaptations

- Existing owner admission, cancellation, deadline, binding and session precedence is unchanged. Owner cancellation preempts diagnostic rendering. Without that cancellation, a terminal Deadline or Cancelled diagnostic keeps its terminal-specific source mapping.
- Raw diagnostic fields and composed messages are limited to 65,536 UTF-8 bytes. Strings must be valid Unicode. These are bounded TypeScript profile limits, not claims about Rust's unbounded diagnostic inputs.
- Every rendered diagnostic passes through the existing owned CPU redaction worker. A busy, failed or empty rendering uses a fixed safe fallback; raw text and rendering exceptions never become fallback wire content.
- The wire message is truncated to 1,000 Unicode scalars only after redaction. This is a protocol-compatible safety adaptation, not byte-for-byte equivalence for arbitrarily long Rust diagnostics.
- Request IDs remain the exact owner-supplied strings, including leading zeros and numeric-looking values beyond JavaScript's safe integer range. The mapper bounds them to 4,096 UTF-8 bytes, narrower than the dispatcher's existing 4,096 UTF-16-unit admission guard. An over-byte-limit ID can therefore reject during awaited mapping after a leaf return and preserve the mutation uncertainty barrier. Receipts cannot supply or replace wire identity. Results are immutable.
- Exact request identity and one-use consumption strengthen custody. They do not prove the trusted adapter's effect claims.

## Verification and limits

Final verification used pinned Node `24.21.0`, TypeScript `7.0.2`, an explicit strict emitted compiler profile and `--no-strip-types` execution:

- 18 focused tests across two new synthetic test files passed.
- 126 bounded affected tests across 15 selected files passed. This includes the focused tests and is not additive.
- Zero failures, cancellations or skips were reported in those passing runs.
- The selected compiler graph and emitted output excluded the protected test and 913 native-read module. No full-suite, whole-project typecheck, full production build or native-backend PASS is claimed.
- An independent source review found no production blocker, reproduced the 18 focused tests, passed four additional synthetic uncertainty/authenticity checks, and verified all 12 exact Rust source bindings. These counts overlap the main verification and are not additive.

Fixtures cover all mapped families/variants, nested error code distinctions, original request identity, private captured data, bounded/redacted output, safe rendering fallback, owner cancellation, receipt authenticity/request binding/one-use, actual dispatcher routing, unchanged uncached-error behavior, thrown typed failures, malformed returned values, uncertainty across reconnect, joined cancellation and awaited mapper rejection. Existing dispatcher/cache/session/deadline/codec tests supply bounded regression coverage.

The protected `test/remote-agent/redaction.test.ts` was never read, compiled, run or reconstructed. The known UNIX-root EPERM case was not retried. No live database, real terminal/process/filesystem mutation backend, native installation, credentials, operational external service, upload, deployment or external message was used. Windows reserved paths, common startup/dependency/configuration, schema/final wire authority and inactive 893 were left unchanged. Complete native adapter classification and runtime acceptance remain unfinished.
