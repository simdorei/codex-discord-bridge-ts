import {createHash} from 'node:crypto';

export const monotonicNs = (): string => process.hrtime.bigint().toString();
export const wireIdentity = (wire: string) => Object.freeze({
  wireBytes: Buffer.byteLength(wire, 'utf8'),
  wireSha256: createHash('sha256').update(wire, 'utf8').digest('hex'),
});
export interface MeasurementOperation {
  readonly requestId: string;
  readonly role: string;
  readonly wireBytes: number;
  readonly wireSha256: string;
}
export interface MeasurementEvent {
  readonly kind: string;
  readonly atNs: string;
  readonly requestId?: string;
  readonly plannedNs?: string;
  readonly wireBytes?: number;
  readonly wireSha256?: string;
  readonly resultType?: string;
  readonly errorCode?: string;
  readonly outcome?: string;
  readonly probeId?: number;
  readonly lanes?: Readonly<Record<string, number>>;
  readonly retained?: boolean;
  readonly generation?: string;
  readonly errorChain?: readonly string[];
}
export interface DriverBatch {readonly kind: 'batch'; readonly wires: readonly string[]; readonly spacingMs: number;}
export type DriverInput = DriverBatch | {readonly kind: 'probe-ack'; readonly probeId: number; readonly observedNs: string} | {readonly kind: 'close'};
export type DriverOutput =
  | {readonly kind: 'ready'; readonly remoteUrl: string; readonly gatewayUrl: string; readonly httpOrigin: string}
  | {readonly kind: 'event'; readonly event: MeasurementEvent}
  | {readonly kind: 'probe'; readonly probeId: number; readonly plannedNs: string; readonly atNs: string}
  | {readonly kind: 'closed'};
const ns = (value: string): bigint => {if (!/^\d+$/.test(value)) throw new TypeError('Expected monotonic nanoseconds'); return BigInt(value);};
const operationKinds = new Set(['injected', 'send-completed', 'send-failure', 'leaf-started', 'leaf-cancelled', 'leaf-settled', 'result']);
const probeKinds = new Set(['probe-sent', 'probe-observed', 'probe-ack']);
const difference = (end: string, start: string): string => (ns(end) - ns(start)).toString();
export function distributionNs(values: readonly string[]) {
  const sorted = values.map(value => {if (!/^-?\d+$/.test(value)) throw new TypeError('Expected duration nanoseconds'); return BigInt(value);}).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const at = (p: number) => sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!.toString();
  return {samples: sorted.length, minimum: at(0), median: at(.5), p95: at(.95), maximum: at(1)};
}

/** External observations only. A missing result never becomes inferred success,
 * cancellation, queue admission, or resource release. Worker gauges are samples. */
export class RuntimeMeasurementRecorder {
  readonly operations = new Map<string, MeasurementOperation>();
  readonly events: MeasurementEvent[] = [];
  declare(requestId: string, role: string, wire: string): void {
    if (this.operations.has(requestId)) throw new Error('Duplicate declared request ID');
    if (JSON.parse(wire).request_id !== requestId) throw new Error('Wire request ID differs');
    this.operations.set(requestId, Object.freeze({requestId, role, ...wireIdentity(wire)}));
  }
  record(event: MeasurementEvent): void {
    ns(event.atNs);
    if (operationKinds.has(event.kind) && event.requestId === undefined) throw new TypeError('Operation event requires request ID');
    if (!operationKinds.has(event.kind) && event.requestId !== undefined) throw new TypeError('Non-operation event cannot carry request ID');
    if (event.kind === 'injected' && (!Number.isSafeInteger(event.wireBytes) || event.wireBytes! < 1 || !/^[a-f0-9]{64}$/.test(event.wireSha256 ?? '') || event.plannedNs === undefined)) throw new TypeError('Injection requires wire identity and planned time');
    if (event.kind === 'result' && (typeof event.resultType !== 'string' || event.resultType === '' || event.resultType === 'operation_error' && typeof event.errorCode !== 'string')) throw new TypeError('Result requires result type and error code');
    if (event.kind === 'result' && event.resultType !== 'operation_error' && event.errorCode !== undefined) throw new TypeError('Successful result cannot carry an error code');
    if (event.kind === 'leaf-settled' && typeof event.outcome !== 'string') throw new TypeError('Leaf settlement requires outcome');
    if (probeKinds.has(event.kind) && (!Number.isSafeInteger(event.probeId) || event.probeId! < 1 || event.plannedNs === undefined)) throw new TypeError('Probe event requires identity and planned time');
    if (event.kind === 'native-lane-sample' && (event.lanes === undefined || Object.values(event.lanes).some(value => !Number.isSafeInteger(value) || value < 0))) throw new TypeError('Native lane sample requires nonnegative counts');
    if (event.plannedNs !== undefined) ns(event.plannedNs);
    if (event.requestId !== undefined && !this.operations.has(event.requestId)) throw new Error('Undeclared observed request ID');
    if (this.events.length >= 20000) throw new Error('Measurement event budget exhausted');
    this.events.push(Object.freeze({...event}));
  }
  report() {
    const issues: string[] = [];
    const resultLatencies: string[] = [], dispatchLatencies: string[] = [], injectionLateness: string[] = [];
    const operations = [...this.operations.values()].map(operation => {
      const events = this.events.filter(e => e.requestId === operation.requestId).sort((a, b) => ns(a.atNs) < ns(b.atNs) ? -1 : ns(a.atNs) > ns(b.atNs) ? 1 : 0);
      const one = (kind: string) => {
        const matches = events.filter(e => e.kind === kind);
        if (matches.length > 1) issues.push(`${operation.requestId}: duplicate ${kind}`);
        return matches[0];
      };
      const sent = one('send-completed'), sendFailure = one('send-failure');
      const injected = one('injected'), started = one('leaf-started'), cancelled = one('leaf-cancelled'), settled = one('leaf-settled'), result = one('result');
      if (injected !== undefined && (injected.wireBytes !== operation.wireBytes || injected.wireSha256 !== operation.wireSha256)) issues.push(`${operation.requestId}: injected wire identity differs`);
      if (sent !== undefined && injected === undefined) issues.push(`${operation.requestId}: send completion without injection`);
      if (sent !== undefined && sendFailure !== undefined) issues.push(`${operation.requestId}: conflicting send callback outcomes`);
      if (started !== undefined && injected === undefined) issues.push(`${operation.requestId}: leaf start without injection`);
      if (settled !== undefined && started === undefined) issues.push(`${operation.requestId}: leaf settlement without start`);
      if (cancelled !== undefined && started === undefined) issues.push(`${operation.requestId}: leaf cancellation without start`);
      if (result !== undefined && injected === undefined) issues.push(`${operation.requestId}: result without injection`);
      for (const [before, after, name] of [[injected, started, 'inject/start'], [injected, sent, 'inject/send-completed'], [started, cancelled, 'start/cancel'], [started, settled, 'start/settle'], [cancelled, settled, 'cancel/settle'], [injected, result, 'inject/result'], [settled, result, 'settle/result']] as const) {
        if (before !== undefined && after !== undefined && ns(after.atNs) < ns(before.atNs)) issues.push(`${operation.requestId}: reversed ${name}`);
      }
      if (injected?.plannedNs !== undefined) injectionLateness.push(difference(injected.atNs, injected.plannedNs));
      if (injected !== undefined && started !== undefined) dispatchLatencies.push(difference(started.atNs, injected.atNs));
      if (injected !== undefined && result !== undefined) resultLatencies.push(difference(result.atNs, injected.atNs));
      const outcome = result !== undefined ? result.errorCode === 'bridge_busy' ? 'explicit-refusal' : result.errorCode === undefined ? 'wire-result' : 'wire-error'
        : injected === undefined ? 'not-injected' : cancelled !== undefined && settled !== undefined ? 'cancelled-leaf-settled-no-wire' : 'no-result-observed';
      return {...operation, outcome, injectedNs: injected?.atNs ?? null, plannedNs: injected?.plannedNs ?? null, startedNs: started?.atNs ?? null,
        cancelledNs: cancelled?.atNs ?? null, settledNs: settled?.atNs ?? null, resultNs: result?.atNs ?? null,
        sendCompletedNs: sent?.atNs ?? null, sendFailureNs: sendFailure?.atNs ?? null, sendFailure: sendFailure?.outcome ?? null,
        resultWireBytes: result?.wireBytes ?? null, resultWireSha256: result?.wireSha256 ?? null, resultType: result?.resultType ?? null, errorCode: result?.errorCode ?? null, leafOutcome: settled?.outcome ?? null};
    });
    let active = 0, peakActive = 0, outstandingBytes = 0, peakOutstandingBytes = 0;
    const ordered = [...this.events].sort((a, b) => ns(a.atNs) < ns(b.atNs) ? -1 : ns(a.atNs) > ns(b.atNs) ? 1 : 0);
    for (const e of ordered) {
      if (e.kind === 'leaf-started') peakActive = Math.max(peakActive, ++active);
      if (e.kind === 'leaf-settled') active--;
      if (active < 0) issues.push('External leaf balance became negative');
      if (e.kind === 'injected') {outstandingBytes += e.wireBytes ?? 0; peakOutstandingBytes = Math.max(peakOutstandingBytes, outstandingBytes);}
      if (e.kind === 'result') outstandingBytes -= this.operations.get(e.requestId!)?.wireBytes ?? 0;
    }
    const probes = this.events.filter(e => e.kind === 'probe-observed');
    const probeIds = [...new Set(this.events.filter(e => probeKinds.has(e.kind)).map(e => e.probeId!))];
    const probeObservations = probeIds.map(probeId => {
      const one = (kind: string) => {const matching = this.events.filter(e => e.kind === kind && e.probeId === probeId); if (matching.length > 1) issues.push(`probe ${probeId}: duplicate ${kind}`); return matching[0];};
      const sent = one('probe-sent'), observed = one('probe-observed'), ack = one('probe-ack');
      if (observed !== undefined && sent === undefined || ack !== undefined && observed === undefined) issues.push(`probe ${probeId}: missing predecessor`);
      if (sent !== undefined && observed !== undefined && (ns(observed.atNs) < ns(sent.atNs) || observed.plannedNs !== sent.plannedNs)) issues.push(`probe ${probeId}: observation chronology differs`);
      if (observed !== undefined && ack !== undefined && (ns(ack.atNs) < ns(observed.atNs) || ack.plannedNs !== observed.atNs)) issues.push(`probe ${probeId}: acknowledgement chronology differs`);
      return {probeId, plannedNs: sent?.plannedNs ?? null, sentNs: sent?.atNs ?? null, observedNs: observed?.atNs ?? null, acknowledgedNs: ack?.atNs ?? null};
    });
    const probeLags = probes.map(e => difference(e.atNs, e.plannedNs!));
    const probeSendLags = probeObservations.flatMap(e => e.sentNs === null || e.plannedNs === null ? [] : [difference(e.sentNs, e.plannedNs)]);
    const probeTransitLags = probeObservations.flatMap(e => e.sentNs === null || e.observedNs === null ? [] : [difference(e.observedNs, e.sentNs)]);
    const samples = this.events.filter(e => e.kind === 'native-lane-sample');
    const sampleMaxima: Record<string, number> = {};
    for (const sample of samples) for (const [lane, value] of Object.entries(sample.lanes ?? {})) sampleMaxima[lane] = Math.max(sampleMaxima[lane] ?? 0, value);
    const window = (startKind: string, endKind: string) => {
      const start = this.events.find(e => e.kind === startKind), end = this.events.find(e => e.kind === endKind);
      const inside = start === undefined || end === undefined ? [] : this.events.filter(e => ns(e.atNs) >= ns(start.atNs) && ns(e.atNs) <= ns(end.atNs));
      return {startNs: start?.atNs ?? null, endNs: end?.atNs ?? null,
        gatewayHeartbeatNs: inside.filter(e => e.kind === 'gateway-heartbeat').map(e => e.atNs),
        observedProbeIds: inside.filter(e => e.kind === 'probe-observed').map(e => e.probeId!)};
    };
    return {
      operations, issues,
      phaseObservations: {loadUntilHeldRelease: window('load-start', 'held-release'), shutdownUntilJoined: window('shutdown-requested', 'runtime-joined')},
      externalCounts: {declared: operations.length, injected: operations.filter(o => o.injectedNs !== null).length,
        startedLeaves: operations.filter(o => o.startedNs !== null).length, settledLeaves: operations.filter(o => o.settledNs !== null).length,
        cancellationObservedLeaves: operations.filter(o => o.cancelledNs !== null).length, wireResults: operations.filter(o => o.resultNs !== null).length,
        explicitRefusals: operations.filter(o => o.outcome === 'explicit-refusal').length, wireErrors: operations.filter(o => o.outcome === 'wire-error').length,
        missingWireResults: operations.filter(o => o.injectedNs !== null && o.resultNs === null).length, stillActiveLeaves: active, peakActiveLeaves: peakActive,
        totalInjectedWireBytes: operations.filter(o => o.injectedNs !== null).reduce((sum, o) => sum + o.wireBytes, 0),
        peakInjectedBytesAwaitingWireResult: peakOutstandingBytes, finalInjectedBytesWithoutWireResult: outstandingBytes},
      diagnosticsNs: {injectionLateness: distributionNs(injectionLateness), injectToLeafStart: distributionNs(dispatchLatencies),
        injectToWireResultIncludingErrors: distributionNs(resultLatencies), independentProbePlannedToMainObservation: distributionNs(probeLags), independentProbeSchedulingLateness: distributionNs(probeSendLags), independentProbeSendToMainObservation: distributionNs(probeTransitLags)},
      nativeLanes: {kind: 'sampled-occupied-counts-not-exact-peaks', samples: samples.length, sampleMaxima},
      heartbeatObservations: this.events.filter(e => e.kind === 'gateway-heartbeat'),
      lifecycle: this.events.filter(e => e.requestId === undefined && !['probe-observed', 'probe-sent', 'probe-ack', 'native-lane-sample', 'gateway-heartbeat'].includes(e.kind)),
      independentProbes: {sent: this.events.filter(e => e.kind === 'probe-sent').length, observed: probes.length,
        acknowledged: this.events.filter(e => e.kind === 'probe-ack').length, observations: probeObservations},
      unobserved: ['private connection and dispatcher queue peaks', 'internal retained command bytes and heap', 'exact native submission totals',
        'whole-runtime lane saturation and fairness', 'external provider outcomes', 'durable acceptance and delivery acknowledgement'],
    };
  }
}
