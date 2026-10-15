# Native live interaction policy refresh

Ordinary installed Normal and Reserved interaction ingress now refreshes its complete dynamic access policy in the existing native mirror-policy worker before constructing a dispatcher. Direct ordinary-handler callers retain their compatibility refresh unless they explicitly install another captured port.

## Ownership and behavior

- The native policy reader remains one process-global slot sharing the three Background slots within the eight-worker total. Reads never use a per-handler pool, queue, cache, completion FIFO or retry.
- Only proven unsubmitted singleton-busy or actual shared-admission refusals receive the private policy-capacity brand. The shared admission proof is bound to the exact slot, rejected Promise and error, and consumed once. The policy proof is separately bound to the creating refresh invocation and its returned Promise, then consumed once by the handler. Replaying a genuine old capacity error through another refresh cannot authorize event-local handling. Public error names/classes, unrelated errors and admitted failures cannot create proof.
- The handler converts only that private policy brand to the existing event-local interaction Capacity error before any dispatcher, claim, journal admission, ACK or work-queue reservation exists. Accepted concurrent handlers remain independently owned.
- Paths, explicit limits, refresh callbacks, handler options and clock methods are captured before asynchronous work. Native timeout and cancellation retain ownership and join actual exit before settling. Native I/O is not terminated to simulate completion.
- Every event refreshes, including already-expired input. The original received timestamp and its 2500 ms ACK deadline remain unchanged. A late policy cannot create a new deadline or admit work.
- Fresh dynamic IDs replace previous dynamic IDs while static channel/user restrictions remain intact. Failure never returns a stale policy, partial list or allow-all fallback.
- The worker still performs the original two ordered reads with separate existing-only read-only connections. This is not a stronger atomic multi-query snapshot. It never initializes or migrates a missing/incompatible database.

## Installation and unchanged paths

Prepared interaction ingress requires explicit native limits. Prepared typed ingress captures its interactionPolicyLimits separately from historyTargetLimits; the local application supplies the existing startup-equivalent policy bounds (4096 rows, 4194304 value bytes, 8192 output IDs, 10000 ms) without changing startup bounds.

Gateway message and history policy refresh remain unchanged. Message pre-admission loss and period-null history retry behavior require separate designs. This change does not activate stage 893 or alter final store authority, production readiness or Windows qualification.

## Verification

Use the pinned Node 24.21.0 binary, tools/build-test-profile.mjs, and emitted tests with NODE_OPTIONS=--no-strip-types. The focused policy/handler suites cover installed poisoned facade/main-thread SQLite, live mapping removal and exact bigint IDs, real Normal/Reserved overlap, unrelated Background saturation, single-use admission proof, forged/public and admitted failures, lock cancellation/timeout actual-exit ownership, original ACK deadline, captured limits/path/callbacks, missing/incompatible stores, malformed rows/results and complete row/value/output budgets.

The protected remote-agent redaction test and the known Unix root-store-authority EPERM profile are outside this bounded validation. No live database, credentials, raw logs, publication or deployment are involved.

### Checkpoint 902 validation result

Final emitted profile: `.runtime/compiled-tests-zUh23k`, Node 24.21.0, baseline `2c0268337d724c14d8e06ae2ea03725130755adf`.

- Strict full source/test typecheck, production build and whitespace check passed.
- All 937 emitted production modules byte-match the production build.
- Focused policy/handler validation: 44/44 passed across three selected files.
- Bounded affected validation: 126/126 passed across fourteen additional selected files.
- Independent final-profile validation: 68/68 passed across seven selected policy/handler/shared-slot suites. These overlap the writer suites and are not additional unique coverage.
- All final runs had zero failures, cancellations or skipped tests. Earlier profiles and the initially reproduced stale-capacity-error replay finding are not counted as final passes. The replay regression is now covered for unsubmitted, admitted and custom-refresh errors, including an unconsumed genuine prior refusal.

This is bounded validation, not a full-suite, long-running production, live-service or Windows qualification. Gateway-message and history refresh remain deferred as described above.
