import test from 'node:test';
import assert from 'node:assert/strict';
import {RuntimeMeasurementRecorder, wireIdentity, distributionNs} from '../../helpers/runtime-measurement.ts';
const wire = (id: string) => JSON.stringify({request_id: id, content: 'é🧪'});
const recorder = () => {const r = new RuntimeMeasurementRecorder(); r.declare('synthetic-9007199254740993-é', 'fixture', wire('synthetic-9007199254740993-é')); return r;};
const id = 'synthetic-9007199254740993-é';

test('measurement uses exact UTF-8 wire bytes and preserves large string IDs', () => {
  const r = recorder(), text = wire(id);
  assert.notEqual(Buffer.byteLength(text), text.length);
  r.record({kind: 'injected', requestId: id, atNs: '100', plannedNs: '90', ...wireIdentity(text)});
  r.record({kind: 'result', requestId: id, atNs: '150', resultType: 'operation_error', errorCode: 'bridge_busy'});
  const report = r.report();
  assert.deepEqual(report.issues, []);
  assert.equal(report.operations[0]!.requestId, id);
  assert.equal(report.externalCounts.explicitRefusals, 1);
  assert.equal(report.externalCounts.totalInjectedWireBytes, Buffer.byteLength(text));
  assert.equal(report.externalCounts.finalInjectedBytesWithoutWireResult, 0);
  assert.equal(report.diagnosticsNs.injectToWireResultIncludingErrors.maximum, '50');
});

test('measurement includes error responses in distributions and leaves absent results unresolved', () => {
  const r = recorder(); r.declare('synthetic-missing', 'fixture', wire('synthetic-missing'));
  r.record({kind: 'injected', requestId: id, atNs: '100', plannedNs: '100', ...wireIdentity(wire(id))});
  r.record({kind: 'result', requestId: id, atNs: '140', resultType: 'operation_error', errorCode: 'requestexpired'});
  r.record({kind: 'injected', requestId: 'synthetic-missing', atNs: '110', plannedNs: '110', ...wireIdentity(wire('synthetic-missing'))});
  const report = r.report();
  assert.equal(report.externalCounts.wireErrors, 1);
  assert.equal(report.externalCounts.missingWireResults, 1);
  assert.equal(report.operations[1]!.outcome, 'no-result-observed');
  assert.equal(report.diagnosticsNs.injectToWireResultIncludingErrors.samples, 1);
  assert.deepEqual(report.diagnosticsNs.injectToLeafStart, {samples: 0, minimum: null, median: null, p95: null, maximum: null});
});

test('measurement distinguishes cancellation from actual late settlement and missing wire delivery', () => {
  const r = recorder();
  r.record({kind: 'injected', requestId: id, atNs: '10', plannedNs: '10', ...wireIdentity(wire(id))});
  r.record({kind: 'leaf-started', requestId: id, atNs: '20'});
  r.record({kind: 'leaf-cancelled', requestId: id, atNs: '30'});
  assert.equal(r.report().externalCounts.stillActiveLeaves, 1);
  assert.equal(r.report().operations[0]!.outcome, 'no-result-observed');
  r.record({kind: 'leaf-settled', requestId: id, atNs: '60', outcome: 'returned-after-cancellation'});
  const report = r.report();
  assert.equal(report.operations[0]!.outcome, 'cancelled-leaf-settled-no-wire');
  assert.equal(report.externalCounts.stillActiveLeaves, 0);
  assert.equal(report.externalCounts.missingWireResults, 1);
});

test('measurement reports duplicate, wire mismatch and chronology errors instead of hiding them', () => {
  const r = recorder();
  r.record({kind: 'injected', requestId: id, atNs: '10', plannedNs: '10', wireBytes: 1, wireSha256: 'b'.repeat(64)});
  r.record({kind: 'leaf-started', requestId: id, atNs: '9'});
  r.record({kind: 'leaf-started', requestId: id, atNs: '11'});
  assert.deepEqual(r.report().issues, [`${id}: duplicate leaf-started`, `${id}: injected wire identity differs`, `${id}: reversed inject/start`]);
  assert.throws(() => r.declare(id, 'duplicate', wire(id)), /Duplicate/);
  assert.throws(() => r.record({kind: 'result', requestId: 'foreign', atNs: '100', resultType: 'write_file_result'}), /Undeclared/);
});

test('independent scheduled probe times expose observation delay and sampled gauges stay labeled', () => {
  const r = recorder();
  r.record({kind: 'probe-sent', probeId: 1, atNs: '110', plannedNs: '100'});
  r.record({kind: 'probe-observed', probeId: 1, atNs: '1000', plannedNs: '100'});
  r.record({kind: 'native-lane-sample', atNs: '1000', lanes: {Background: 2}});
  const report = r.report();
  assert.equal(report.diagnosticsNs.independentProbePlannedToMainObservation.maximum, '900');
  assert.equal(report.nativeLanes.kind, 'sampled-occupied-counts-not-exact-peaks');
  assert.equal(report.independentProbes.acknowledged, 0);
  assert.equal(report.operations[0]!.outcome, 'not-injected');
  assert.deepEqual(distributionNs(['1', '9', '2', '3']), {samples: 4, minimum: '1', median: '2', p95: '9', maximum: '9'});
});


test('measurement validates required operation and probe fields before counting', () => {
  const r = recorder();
  assert.throws(() => r.record({kind: 'leaf-started', atNs: '1'}), /requires request ID/);
  assert.throws(() => r.record({kind: 'probe-observed', atNs: '1', probeId: 1}), /requires identity/);
  assert.throws(() => r.record({kind: 'injected', requestId: id, atNs: '1'}), /requires wire identity/);
  assert.throws(() => r.record({kind: 'result', requestId: id, atNs: '1', resultType: 'operation_error'}), /requires result type/);
  assert.throws(() => r.record({kind: 'result', requestId: id, atNs: '1', resultType: 'write_file_result', errorCode: 'bridge_busy'}), /cannot carry an error code/);
  assert.equal(r.report().externalCounts.peakActiveLeaves, 0);
});

test('measurement detects cancellation after settlement and invalid probe lineage', () => {
  const r = recorder();
  r.record({kind: 'injected', requestId: id, atNs: '10', plannedNs: '10', ...wireIdentity(wire(id))});
  r.record({kind: 'leaf-started', requestId: id, atNs: '20'});
  r.record({kind: 'leaf-settled', requestId: id, atNs: '30', outcome: 'returned-success'});
  r.record({kind: 'leaf-cancelled', requestId: id, atNs: '40'});
  r.record({kind: 'probe-observed', probeId: 1, atNs: '50', plannedNs: '10'});
  assert.deepEqual(r.report().issues, [`${id}: reversed cancel/settle`, 'probe 1: missing predecessor']);
});


test('measurement detects invalid send completion and preserves pre-injection send failure', () => {
  const r = recorder();
  r.record({kind: 'send-completed', requestId: id, atNs: '1'});
  assert.ok(r.report().issues.includes(`${id}: send completion without injection`));
  r.record({kind: 'injected', requestId: id, atNs: '2', plannedNs: '2', ...wireIdentity(wire(id))});
  r.record({kind: 'send-failure', requestId: id, atNs: '3', outcome: 'send-error'});
  assert.ok(r.report().issues.includes(`${id}: reversed inject/send-completed`));
  assert.ok(r.report().issues.includes(`${id}: conflicting send callback outcomes`));
  const failed = recorder(); failed.record({kind: 'send-failure', requestId: id, atNs: '1', outcome: 'socket-not-open'});
  assert.deepEqual(failed.report().issues, []);
  assert.equal(failed.report().operations[0]!.sendFailure, 'socket-not-open');
});
