# Native mutation persistence transport extraction

## Scope

The existing NativeMutationOwner now uses NativeMutationTransport for its fixed native persistence worker. This is a same-isolate implementation extraction. It does not enroll a persistent worker, move authority across an IPC boundary, activate a new runtime path, or change the final database-to-wire validation order.

NativeMutationOwner keeps claim validation and cloning, its private unused receipt ledger, completion receipt consumption, exact owner/attempt/wire/method refusal association, public-safe diagnostic rendering, outcome-unknown classification, and synchronous createNativeMutationRevalidator. Existing consumers and its public API are unchanged.

NativeMutationTransport keeps actual Control slots, cancellation forwarding, worker joins, execution tasks and close. It accepts only the existing five mutation operations and constructs only native-mutation-worker.ts. It does not accept an adapter, worker URL, lane, SQL, or dispatch callback. Begin operations retain zero queue. Completion operations retain the existing bounded Control completion FIFO. Abort and timeout do not terminate a database worker or release its slot before actual exit.

## Admission and lifetime

Every submission executes through the synchronous admission sample before submit returns its promise. A private WeakMap binds that phase to that exact promise and transport. The owner never consults a later slot.busy value. Queued completion is conservatively admitted even when cancellation prevents native construction.

The sample preserves the existing trusted-module meaning of slot.busy and the existing not-admitted plus OwnedWorkerBusyError classification. It is not stronger provenance, a database commit receipt, or permission to perform a wire effect. Direct transport callers are trusted internal modules; the transport is not a public capability boundary or a substitute for owner claim capture.

The owner retains a separate set of classified tasks. This preserves busy during public-safe rendering, including a renderer that synchronously reenters the owner. Owner close marks it closed, aborts/closes the transport, and joins classified tasks without making transport tasks wait for owner classification. The owner checks cancellation/close again after the raw-result promise boundary before rendering. Final receipt validation remains synchronous in the original isolate.

## Qualification

Author qualification used Node 24.21.0 and TypeScript 7.0.2 on Linux. The guarded closure contained 312 project files; the separate production-only compile covered 302 files and emitted identical production JavaScript. Seven explicit test roots passed 86/86 with no skipped or failed cases. They covered owner persistence and receipts, the extracted transport, custody validation, installed resident dispatch/startup, and existing slot/budget regressions.

New cases exercised exact/foreign/wrapped submission promises, true Control saturation without additional worker construction, actual database completion FIFO and cancelled entries, close of queued and active work, main-only submission, exact owner/attempt/wire/method refusal association, renderer reentrancy, and cancellation/close at the joined raw-result Promise boundary. Existing owner cases retained accepted timeout/cancellation and durable prepared intent, forged/cross-owner receipt rejection, failed completion consumption and final identity validation.

The first frozen author version passed 84/84. A second test-only version added the two raw-result boundary cases and passed 86/86. One executor transport disconnect prevented an initial second-version launch; process and output checks found no run, and one retry executed successfully. No test failures were repaired by changing deadlines, capacity or limits. Independent code review found no required findings within this extraction. Independent frozen reproduction also passed 86/86 with zero failed, skipped or cancelled cases; its 312-file selected graph, 302-file production-only emitted JavaScript parity and emitted graph matched the author result.

This is selected Linux component qualification. No whole migration, Windows, performance, persistent-worker/store-role integration, or production qualification is claimed.
