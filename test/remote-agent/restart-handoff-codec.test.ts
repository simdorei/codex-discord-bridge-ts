import {it} from 'node:test';
import assert from 'node:assert/strict';
import {inspect} from 'node:util';
import {
 RestartHandoffCodecError, restartHandoffGatewayFingerprint,
 encodeRestartHandoffPayload, decodeRestartHandoffPayload,
 encodeRestartHandoffEnvelope, decodeRestartHandoffEnvelope,
 MAX_RESTART_HANDOFF_BYTES, MAX_RESTART_HANDOFF_PROJECTS,
 type RestartHandoffProject, type RestartHandoffBinding,
} from '../../src/remote-agent/restart-handoff-codec.ts';
import {parseRemoteUtcDateTime, type RemoteUtcDateTime} from '../../src/remote-agent/datetime.ts';
import {formatRemoteUtcDateTime} from '../../src/remote-agent/datetime-format.ts';

const date = (raw: string) => parseRemoteUtcDateTime(raw, 1000);
const now = date('2026-08-31T01:02:03Z');
const binding = Object.freeze({bridgeUrl: 'wss://example.test/v12/bridge', deviceId: 'device-a'});
const project = (threadId = 'synthetic-thread', root = '/synthetic/project'): RestartHandoffProject =>
 Object.freeze({threadId, root, expiresAt: date('2026-08-31T01:12:03Z')});
const raw = (): string => encodeRestartHandoffPayload([project()], binding, now)!;
const wire = (): Record<string, any> => JSON.parse(raw());
const decode = (value: unknown) => decodeRestartHandoffPayload(JSON.stringify(value), binding, now);
function error(code: string): (value: unknown) => boolean {
 return value => value instanceof RestartHandoffCodecError && value.code === code && value.cause === undefined;
}
it('writer preserves source version, field order, exact UTC strings and 120-second deadline', () => {
 const value = wire();
 assert.deepEqual(Object.keys(value), ['format_version', 'protocol_version', 'gateway_fingerprint', 'created_at', 'resume_until', 'projects']);
 assert.deepEqual(Object.keys(value.projects[0]), ['thread_id', 'root', 'expires_at']);
 assert.equal(value.format_version, 1); assert.equal(value.protocol_version, 10);
 assert.equal(value.created_at, '2026-08-31T01:02:03Z');
 assert.equal(value.resume_until, '2026-08-31T01:04:03Z');
 const result = decodeRestartHandoffPayload(raw(), binding, now);
 assert.equal(result.formatVersion, 1n); assert.equal(result.protocolVersion, 10n);
 assert.deepEqual(result.projects, [project()]);
 assert.ok(Object.isFrozen(result) && Object.isFrozen(result.projects) && Object.isFrozen(result.projects[0]) && Object.isFrozen(result.createdAt) && Object.isFrozen(result.projects[0]!.expiresAt));
});
it('fingerprint uses exact URL display bytes, NUL delimiter and device ID without token', () => {
 assert.equal(restartHandoffGatewayFingerprint(binding), 'b94654138b0b86b6260d007ab61e76259d705e413c79d8a8f3364e767d5eefcc');
 for (const other of [{...binding, deviceId: 'Device-a'}, {...binding, bridgeUrl: binding.bridgeUrl + '/'}, {...binding, bridgeUrl: 'WSS://example.test/v12/bridge'}]) {
  assert.notEqual(restartHandoffGatewayFingerprint(other), restartHandoffGatewayFingerprint(binding));
 }
 assert.notEqual(restartHandoffGatewayFingerprint({bridgeUrl: 'ab', deviceId: 'c'}), restartHandoffGatewayFingerprint({bridgeUrl: 'a', deviceId: 'bc'}));
 const marker = 'synthetic-token-must-not-be-consumed';
 assert.throws(() => restartHandoffGatewayFingerprint({...binding, deviceToken: marker} as RestartHandoffBinding), error('Malformed'));
 assert.equal(raw().includes(marker), false);
});
it('writer retains duplicate IDs, Unicode vector order and empty/noncanonical strings without filesystem access', () => {
 const projects = [project('😀', '../synthetic'), project('\uE000', ''), project('😀', 'Z:/synthetic/../root'), project('', '')];
 const parsed = decodeRestartHandoffPayload(encodeRestartHandoffPayload(projects, binding, now)!, binding, now);
 assert.deepEqual(parsed.projects, projects);
});
it('writer accepts 128 handoff projects without changing the separate 16-project integration limit', () => {
 assert.equal(MAX_RESTART_HANDOFF_PROJECTS, 128);
 const projects = Array.from({length: 128}, (_, i) => project(String(i)));
 assert.equal(decodeRestartHandoffPayload(encodeRestartHandoffPayload(projects, binding, now)!, binding, now).projects.length, 128);
 assert.throws(() => encodeRestartHandoffPayload([...projects, project()], binding, now), error('TooLarge'));
});
it('empty writer skips context capture, while malformed vectors fail passively', () => {
 let calls = 0;
 const hostile = new Proxy({}, {get() { calls++; throw Error('private'); }, getPrototypeOf() { calls++; throw Error('private'); }});
 assert.equal(encodeRestartHandoffPayload([], hostile as RestartHandoffBinding, hostile as RemoteUtcDateTime), null);
 assert.equal(calls, 0);
 assert.throws(() => encodeRestartHandoffPayload(null as unknown as RestartHandoffProject[], binding, now), error('Malformed'));
});
it('writer does not validate semantic expiry that the source writer leaves to restore', () => {
 const expired = {...project(), expiresAt: now};
 assert.ok(encodeRestartHandoffPayload([expired], binding, now));
 assert.throws(() => decodeRestartHandoffPayload(encodeRestartHandoffPayload([expired], binding, now)!, binding, now), error('ProjectExpired'));
});
it('Chrono leap second positive duration and nanosecond precision are retained', () => {
 const leap = date('2016-12-31T23:59:60.123456789Z');
 const output = JSON.parse(encodeRestartHandoffPayload([project()], binding, leap)!);
 assert.equal(output.created_at, '2016-12-31T23:59:60.123456789Z');
 assert.equal(output.resume_until, '2017-01-01T00:01:59.123456789Z');
 const almost = {...wire(), resume_until: '2026-08-31T01:02:03.000000001Z'};
 assert.doesNotThrow(() => decode(almost));
 almost.resume_until = '2026-08-31T01:02:03Z';
 assert.throws(() => decode(almost), error('Expired'));
});
it('reader preserves source clock-skew and replay limitations without invented creation-time checks', () => {
 const value = {...wire(), created_at: '2100-01-01T00:00:00Z', resume_until: '2099-01-01T00:00:00Z'};
 assert.doesNotThrow(() => decode(value));
 const first = decode(value), second = decode(value);
 assert.deepEqual(first, second); assert.notEqual(first, second);
});
it('reader accepts arbitrary map order and exact-position Serde sequences at all three struct levels', () => {
 const p = wire(), values = [p.format_version, p.protocol_version, p.gateway_fingerprint, p.created_at, p.resume_until,
  [[p.projects[0].thread_id, p.projects[0].root, p.projects[0].expires_at]]];
 assert.deepEqual(decode(values), decode(p));
 assert.deepEqual(decode(Object.fromEntries(Object.entries(p).reverse())), decode(p));
 assert.deepEqual(decodeRestartHandoffEnvelope('[1,"AA=="]'), {formatVersion: 1n, ciphertext: 'AA=='});
});
const semanticCases: readonly [string, Record<string, unknown>, string][] = [
 ['format before protocol/gateway/expiry/empty', {format_version: 2, protocol_version: 11, gateway_fingerprint: '', resume_until: '2000-01-01T00:00:00Z', projects: []}, 'UnsupportedFormat'],
 ['protocol before gateway/expiry/empty', {protocol_version: 11, gateway_fingerprint: '', resume_until: '2000-01-01T00:00:00Z', projects: []}, 'ProtocolMismatch'],
 ['gateway before expiry/empty', {gateway_fingerprint: '', resume_until: '2000-01-01T00:00:00Z', projects: []}, 'GatewayMismatch'],
 ['resume expiry before empty', {resume_until: '2026-08-31T01:02:03Z', projects: []}, 'Expired'],
 ['empty projects after valid deadline', {projects: []}, 'NoProjects'],
 ['project expiry at exact equality', {projects: [{thread_id: '', root: '', expires_at: '2026-08-31T01:02:03Z'}]}, 'ProjectExpired'],
];
for (const [name, patch, code] of semanticCases) it('semantic precedence: ' + name, () => assert.throws(() => decode({...wire(), ...patch}), error(code)));
it('resume expiry precedes count, and count precedes per-project expiry', () => {
 const p = wire(), projects = Array.from({length: 129}, () => ({...p.projects[0], expires_at: p.created_at}));
 assert.throws(() => decode({...p, projects, resume_until: p.created_at}), error('Expired'));
 assert.throws(() => decode({...p, projects}), error('TooLarge'));
});
it('full schema parsing precedes all semantic version checks', () => {
 assert.throws(() => decode({...wire(), format_version: 2, created_at: null}), error('Malformed'));
 assert.throws(() => decode({...wire(), format_version: 2, projects: [{thread_id: '', root: '', expires_at: null}]}), error('Malformed'));
 assert.throws(() => decodeRestartHandoffEnvelope('{"format_version":2,"ciphertext":null}'), error('Malformed'));
 assert.throws(() => decodeRestartHandoffEnvelope('{"format_version":2,"ciphertext":"?"}'), error('UnsupportedFormat'));
});
for (const field of ['format_version', 'protocol_version', 'gateway_fingerprint', 'created_at', 'resume_until', 'projects']) {
 it('required payload field rejects omission and null: ' + field, () => {
  const p = wire(); delete p[field]; assert.throws(() => decode(p), error('Malformed'));
  assert.throws(() => decode({...wire(), [field]: null}), error('Malformed'));
 });
}
for (const representation of ['-1', '256', '1.0', '1e0', '-0', '"1"', 'true', '18446744073709551616']) {
 it('u8 schema rejects invalid integer representation ' + representation, () => {
  assert.throws(() => decodeRestartHandoffEnvelope('{"format_version":' + representation + ',"ciphertext":""}'), error('Malformed'));
 });
}
for (const [name, transform] of [
 ['unknown top-level', (s: string) => s.replace('{', '{"extra":null,')],
 ['duplicate top-level', (s: string) => s.replace('{', '{"format_version":1,')],
 ['escaped duplicate field', (s: string) => s.replace('{', '{"format_\\u0076ersion":1,')],
 ['unknown project', (s: string) => s.replace('"thread_id":', '"extra":null,"thread_id":')],
 ['duplicate project', (s: string) => s.replace('"thread_id":', '"root":"synthetic-duplicate","thread_id":')],
 ['trailing JSON', (s: string) => s + '{}'],
 ['trailing comma', (s: string) => s.slice(0, -1) + ',}'],
 ['escaped lone surrogate', (s: string) => s.replace('synthetic-thread', '\\ud800')],
] as const) it('strict payload syntax: ' + name, () => assert.throws(() => decodeRestartHandoffPayload(transform(raw()), binding, now), error('Malformed')));
it('sequences reject missing or trailing fields and null project members', () => {
 for (const value of [[1, 'AA==', null], [1], [], null, 1]) assert.throws(() => decodeRestartHandoffEnvelope(JSON.stringify(value)), error('Malformed'));
 const p = wire(), values = Object.values(p);
 assert.throws(() => decode(values.slice(0, -1)), error('Malformed'));
 assert.throws(() => decode([...values, null]), error('Malformed'));
 assert.throws(() => decode({...p, projects: [null]}), error('Malformed'));
 assert.throws(() => decode({...p, projects: [['a', 'b', p.created_at, null]]}), error('Malformed'));
});
it('envelope writer uses exact source field order and canonical standard base64', () => {
 for (const encoded of ['', 'AA==', 'AAE=', 'AAEC', '+/8=']) {
  assert.equal(encodeRestartHandoffEnvelope(encoded), '{"format_version":1,"ciphertext":' + JSON.stringify(encoded) + '}');
  assert.deepEqual(decodeRestartHandoffEnvelope(encodeRestartHandoffEnvelope(encoded)), {formatVersion: 1n, ciphertext: encoded});
 }
});
for (const encoded of ['A', 'AA', 'AA=', 'AA===', 'AB==', 'AAF=', ' AA==', 'AA==\n', '-_8=', 'AA==AA==', '?', '😀']) {
 it('base64 rejects permissive-Node-only spelling ' + JSON.stringify(encoded), () => {
  assert.throws(() => encodeRestartHandoffEnvelope(encoded), error('Malformed'));
  assert.throws(() => decodeRestartHandoffEnvelope(JSON.stringify({format_version: 1, ciphertext: encoded})), error('Malformed'));
 });
}
it('envelope duplicate, unknown, missing and trailing fields are malformed', () => {
 for (const input of ['{"format_version":1,"ciphertext":"","ciphertext":""}', '{"format_version":1,"ciphertext":"","extra":null}',
  '{"format_version":1}', '{"ciphertext":""}', '{"format_version":1,"ciphertext":""}null']) {
  assert.throws(() => decodeRestartHandoffEnvelope(input), error('Malformed'));
 }
});
it('outer 1 MiB ceiling counts UTF-8 bytes and precedes JSON/schema failures', () => {
 const small = encodeRestartHandoffEnvelope('');
 assert.doesNotThrow(() => decodeRestartHandoffEnvelope(small + ' '.repeat(MAX_RESTART_HANDOFF_BYTES - small.length)));
 assert.throws(() => decodeRestartHandoffEnvelope(small + ' '.repeat(MAX_RESTART_HANDOFF_BYTES - small.length + 1)), error('TooLarge'));
 assert.throws(() => decodeRestartHandoffEnvelope('é'.repeat(MAX_RESTART_HANDOFF_BYTES / 2 + 1)), error('TooLarge'));
 const largest = 'AAAA'.repeat(Math.floor((MAX_RESTART_HANDOFF_BYTES - small.length) / 4));
 assert.ok(Buffer.byteLength(encodeRestartHandoffEnvelope(largest)) <= MAX_RESTART_HANDOFF_BYTES);
 assert.throws(() => encodeRestartHandoffEnvelope(largest + 'AAAA'), error('TooLarge'));
});
it('independent plaintext input/serialization cap bounds strings and JSON escaping', () => {
 assert.throws(() => decodeRestartHandoffPayload(' '.repeat(MAX_RESTART_HANDOFF_BYTES + 1), binding, now), error('TooLarge'));
 assert.throws(() => encodeRestartHandoffPayload([project('x'.repeat(MAX_RESTART_HANDOFF_BYTES + 1))], binding, now), error('TooLarge'));
 assert.throws(() => encodeRestartHandoffPayload([project('\0'.repeat(200_000))], binding, now), error('TooLarge'));
 assert.throws(() => encodeRestartHandoffPayload([project('a'.repeat(600_000)), project('b'.repeat(600_000))], binding, now), error('TooLarge'));
});
it('caller objects are captured without accessors, Proxy traps, coercion or toJSON', () => {
 let hooks = 0;
 const hook = () => { hooks++; throw Error('synthetic-secret-hook'); };
 const proxy = new Proxy(project(), {get: hook, ownKeys: hook, getPrototypeOf: hook, getOwnPropertyDescriptor: hook});
 const getter = {get threadId() { return hook(); }, root: '', expiresAt: now};
 const coercion = {...project(), threadId: {toString: hook}};
 const toJSON = {...project(), toJSON: hook};
 for (const item of [proxy, getter, coercion, toJSON]) assert.throws(() => encodeRestartHandoffPayload([item as RestartHandoffProject], binding, now), error('Malformed'));
 const revoked = Proxy.revocable(project(), {}); revoked.revoke();
 assert.throws(() => encodeRestartHandoffPayload([revoked.proxy], binding, now), error('Malformed'));
 const array = new Proxy([project()], {get: hook, ownKeys: hook, getPrototypeOf: hook});
 assert.throws(() => encodeRestartHandoffPayload(array, binding, now), error('Malformed'));
 assert.equal(hooks, 0);
});
it('passive shapes reject sparse/accessor/extra/nonenumerable/symbol and class inputs', () => {
 const sparse = new Array<RestartHandoffProject>(1);
 const getter: RestartHandoffProject[] = []; Object.defineProperty(getter, '0', {get() { throw Error('not called'); }, enumerable: true});
 const extra = Object.assign([project()], {extra: true});
 for (const values of [sparse, getter, extra]) assert.throws(() => encodeRestartHandoffPayload(values, binding, now), error('Malformed'));
 class Foreign {threadId = ''; root = ''; expiresAt = now;}
 const hidden = {...project()}; Object.defineProperty(hidden, 'root', {value: '', enumerable: false});
 for (const value of [new Foreign(), hidden, {...project(), [Symbol('extra')]: 1}, {...project(), extra: true}]) assert.throws(() => encodeRestartHandoffPayload([value], binding, now), error('Malformed'));
});
it('null-prototype passive records are accepted and caller data is not mutated', () => {
 const p = Object.assign(Object.create(null), project()), b = Object.assign(Object.create(null), binding);
 const output = encodeRestartHandoffPayload([p], b, Object.assign(Object.create(null), now))!;
 p.root = 'changed'; b.deviceId = 'changed';
 assert.equal(decodeRestartHandoffPayload(output, binding, now).projects[0]!.root, '/synthetic/project');
});
it('dates require bounded bigint seconds/nanoseconds and exact passive shape', () => {
 for (const value of [null, {seconds: 0, nanosecond: 0n}, {seconds: 0n, nanosecond: 0}, {seconds: 10n ** 100n, nanosecond: 0n},
  {seconds: 0n, nanosecond: -1n}, {seconds: 0n, nanosecond: 1_000_000_000n}, {...now, extra: 1}]) {
  assert.throws(() => encodeRestartHandoffPayload([project()], binding, value as RemoteUtcDateTime), error('Malformed'));
 }
 assert.throws(() => encodeRestartHandoffPayload([project()], binding, date('+262142-12-31T23:59:59Z')), error('Malformed'));
});
it('raw strings reject boxes, null, symbols and lone surrogates without coercion', () => {
 let hooks = 0;
 for (const value of [null, 1n, Symbol(), new String(raw()), {toString() { hooks++; return raw(); }}, '\uD800']) {
  assert.throws(() => decodeRestartHandoffPayload(value as string, binding, now), error('Malformed'));
 }
 assert.equal(hooks, 0);
});
it('diagnostics never retain secret-like input or raw parser causes', () => {
 const marker = 'synthetic-sensitive-value-915';
 const bad = '{"format_version":1,"ciphertext":"' + marker + '"}';
 try { decodeRestartHandoffEnvelope(bad); assert.fail('must reject'); } catch (caught) {
  assert.ok(caught instanceof RestartHandoffCodecError);
  assert.equal(inspect(caught).includes(marker), false);
  assert.equal(JSON.stringify(caught).includes(marker), false);
  assert.equal(caught.cause, undefined);
 }
 const malformed = raw().replace('synthetic-thread', marker).slice(0, -1);
 assert.throws(() => decodeRestartHandoffPayload(malformed, binding, now), caught =>
  caught instanceof RestartHandoffCodecError && !inspect(caught).includes(marker));
});
it('reader accepts relaxed Chrono input but returns normalized nanosecond-aware data', () => {
 const value = {...wire(), created_at: '2026-08-31t10:02:03+0900'};
 assert.equal(formatRemoteUtcDateTime(decode(value).createdAt), '2026-08-31T01:02:03Z');
});
