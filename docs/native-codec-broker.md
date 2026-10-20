# Main-owned native codec broker

This production-unwired component makes the original gateway codec available to one trusted persistent requester without moving native-worker ownership out of main. Existing consumers, the original codec and worker, global lane budgets, store accounting, and main-thread guards are unchanged. No persistent production requester is enrolled.

## Custody and limits

`createMainNativeCodecBroker(limits)` requires every configuration field. The canonical main-module singleton permits one live root until close, observed transport disposal, and actual original codec join. A root binds one already-created trusted requester once. It has one retained operation, no waiting submissions, one correlated exchange credit, one cancel latch and one close latch. It cannot reconnect, replace its endpoint, or replay.

Accepted means broker custody, not native admission or permission to dispatch the decoded command. Adapter errors, including global budget refusal, are `adapter-failed`. Pending status is prompt and exposes only retained-or-not-started ownership. Abort and close preserve actual-exit ownership. A stuck native operation can retain the root indefinitely.

A result is sent once and remains reserved until a separate terminal acknowledgement or observed endpoint disposal. The client validates and freezes its private clone before handing the status Promise to the application. Terminal retention expiry closes the endpoint; it does not establish cross-thread event ordering or turn a queued result into proof of acknowledged retirement. Port loss is unknown, without automatic replay.

## Data and accounting

The sole catalog entry is `remote.gateway.decode.v1`. Inputs are primitive strings, bounded in UTF-16 length and UTF-8 bytes before posting and again in main. Decoded data is passive bounded structured clone, with the source's 4096-value/depth-16 maxima and bounded strings, keys and integer magnitudes. No JSON reparse, V8 serialization codec, caller adapter, callback, transferable application buffers or raw application port is exposed. Parsed paths are data, not authority. Omitted gateway deadlines retain the original native worker's time-dependent defaults.

The reservation uses I = 2B and R = 2(B + 32768) + 8(4096) + 4096, and requires at least 3I + 4R + 4096 logical accounted bytes. A narrower application result-string limit does not shrink the original native result allowance. These multiplicities cover raw/result cloning overlap and retained outbound data. They do not measure V8 object headers, serializer internals, GC reclamation or total heap/RSS. Separate graph count limits cover four result copies. Caller-owned input and application-retained fulfilled results are outside broker ownership.

Node MessagePort has no hard receiver queue capacity setting. The count bound depends on the private trusted sender's pre-post credit, not on validating an untrusted raw-port holder. The canonical-module singleton likewise does not confine hostile alternate loaders, duplicate module graphs or separate isolates.

## Bootstrap trust

The fixed trusted bootstrap consumes exactly one initialization envelope, captures its port privately, performs ready exchange 1, and exposes only the client API. Binding invokes the captured Worker prototype postMessage implementation on the supplied exact object, bypassing its overridable method. Proxy, prototype and passive-descriptor checks are defensive validation, not proof of Worker construction identity against hostile same-isolate symbol copying. In pinned Node, that captured implementation is a JavaScript wrapper around the internal MessagePort, not a native Worker brand predicate. Production bootstrap enrollment remains separate work.

## Qualification

Author and independent reviewer each passed the same 32-case frozen qualification on Node 24.21.0 and TypeScript 7.0.2. Both runs compiled an explicit guarded 37-file graph, audited actual compiler inputs, and confirmed byte-for-byte JavaScript parity against a separate 34-file production-only build. An earlier fixture-only TypeScript nullability failure is preserved; it was fixed without changing timing limits or production behavior.

The tests exercise actual persistent requester → main broker → unchanged original codec → actual native worker → actual exit, including hello acknowledgement and command data, invalid JSON, one-time result delivery and explicit retirement, input/result validation, credit and latches, normal closure, repeated close, handshake expiry, fixed malformed requester frames and terminal retention. The requester runtime graph contains only the fixed fixture, client and protocol modules plus builtins.

Global-budget qualification uses both direct original-codec contention and three independently gated real Background workers through the original slot. With all three occupied, the broker invokes its unchanged codec, reports joined `adapter-failed`, and constructs no fourth native worker. Both gates are released and every actual helper exit is joined.

Both runs observed a terminal reservation before endpoint disposal. A separately labelled synthetic test holds the main event loop for 100 ms while the requester delays submission by 25 ms with a 20 ms exchange timeout. Both runs observed the timeout and one native construction followed by actual exit. This is not a production latency result or proof that transport timeout prevents a late native start. Main TTL versus queued result delivery has no invented cross-thread ordering guarantee.

These results do not qualify every design boundary. Remaining gaps are a direct worker-thread main-guard negative probe, malformed client-reply live paths, actual sequential counter exhaustion, constructor/bootstrap transfer failure, all acceptance and ACK-loss boundaries, broker-specific native deadline expiry, and exhaustive queued-result/TTL orderings. Abrupt requester death and native crash qualification are excluded. The module remains production-unwired; no storage or persistent-owner enrollment is authorized by these tests.
