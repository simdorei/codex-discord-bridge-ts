# Checkpoint 937: simultaneous native-lane owner acceptance

This additive experiment measures owner-level C/F/G2/G4 only. It does not qualify Discord heartbeats, storage, connectors, listener transport, OS/native I/O, throughput, memory or runtime byte caps. Offered fixture bytes are synthetic accounting, not a byte-cap claim. No store authority is enrolled.

## Frozen profile (before execution)

- Node 24.21.0 from `.runtime/node24/node_modules/node-linux-x64/bin/node`; TypeScript 7.0.2 CLI with `--ignoreConfig`, explicit immutable source list and rewritten extensions.
- Eight held native workers: Background 3, Control 1, Observation 2, Discovery 1, Maintenance 1. Each owns a separate 16-byte SAB (result-release/start/result/exit-release markers).
- At simultaneous saturation, queue Control 128, Observation 128, Maintenance 2. Entry zero of each queue expires after 3000 ms real time. Other entries have 30000 ms deadlines and are aborted after all three expirations. One extra queue submission per lane and one ordinary submission per five lanes must reject without construction.
- Reseed exactly two FIFO workers per queue, deadline 15000 ms. Release only Control, then first Observation, then Maintenance; release live FIFO entries individually and check other lanes remain held and ordinary work cannot overtake.
- Background zero caller timeout 10000 ms; Background one caller abort after FIFO phase; all other original calls 30000 ms. Their workers remain held through caller settlement and no replacements may construct. Release result barriers, observe late results while exit barriers remain held and join remains pending; then release exit barriers and observe actual exits; caller settlements remain exactly one. Fresh work after join has 15000 ms deadline.
- Exact successful native construction/start/result/exit count is 19 each, plus one separately accounted probe construction/exit; 12 refused submissions and 289 total submissions. Probe samples must be 1–2400, derived from the 25 ms schedule and 60 s guard; these are observation bounds, not performance limits.
- Synthetic offered payload is 64 ASCII bytes per submission (18496 total offered fixture bytes). No offered input implies a runtime byte limit.
- Independent probe worker sends 25 ms anchored sequence messages. Receive lateness and send drift are numeric diagnostics only, never Discord heartbeat or qualification criteria.
- Per-condition guard 15000 ms; test/whole subprocess 60000 ms. Guards come from checkpoint919 termination discipline, not performance acceptance. No deadline changes after failures.
- Constructor IDs observed by test-only Worker subclass installed through CommonJS plus `syncBuiltinESMExports` before dynamic owner import. Successful constructor, actual native exit, and worker-entry/result SAB markers are independent evidence. Probe is outside native owner lane counts.
- Cleanup only releases SAB barriers, aborts unstarted queues, and joins owners; no worker termination manufactures success.

## Closed source graph

Production closure is exactly owned-worker-slot, store-worker-authority, store-worker-manifest, store/store-authority-domain, runtime/runtime-paths/path-text, discord/text. Only these six modules and the three new test/helper roots compile. Manifest string paths are not import permission. Protected redaction and remote-agent native-read paths are never read, compiled or executed. No runtime-measurement-driver, listeners, discovery fallback, production changes or Git writes.

The runner accepts only `--run` or `--compile-only`, emits private immutable attempt records under `.runtime`, validates compiler actual file lists and production byte parity, and preserves all failures. Every subprocess has explicit nonempty argv, bounded timeout and failure propagation. Public summary contains numeric and synthetic evidence only. It is not archive qualification; parent owns archive decisions.

## Reviewed outcome and archival scope

The frozen candidate passed its first writer run and an independent reviewer rerun without source changes or deadline extensions. Both actual compiler lists contained exactly the six production modules and three test/helper modules listed above, with identical emitted module hashes. All six production source hashes remained byte-identical to the pre-run manifest. This parity claim covers that production closure only, not every production file in the repository.

Both runs observed 19 native constructions, starts and exits; 258 queued entries removed without construction (3 expired, 255 cancelled); 12 refused submissions without construction; six FIFO workers; and five fresh successes after actual join. Final occupancy was zero in every lane. The public fixture records the writer's numeric synthetic measurements; probe latency is diagnostic, not a threshold or performance claim.

Accepted evidence is limited to owner C/F and partial G2/G4. Overall qualification remains false. This does not establish installed conversation/control behavior, Discord heartbeat health, transport behavior, runtime byte limits, OS-native I/O or full release readiness. No production source changes, listener work, protected path access or Git writes were part of this checkpoint. This outcome section was appended after both runs; the final archival manifest separately binds the final documentation and fixture while retaining both original execution manifests.

An additional production-only TypeScript compilation subsequently used the same frozen compiler options with only the six production roots and a separate private output directory. Its actual project file list was exactly those six modules, and every emitted production JavaScript file matched the corresponding selected-build output byte-for-byte. The compilation passed on its first attempt; no test rerun or source edits were needed. This is narrow emitted-byte parity evidence, not a full production build or behavioral qualification.
