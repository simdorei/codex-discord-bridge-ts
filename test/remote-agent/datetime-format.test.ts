import {it} from 'node:test';import assert from 'node:assert/strict';
import {parseRemoteUtcDateTime} from '../../src/remote-agent/datetime.ts';
import {formatRemoteUtcDateTime} from '../../src/remote-agent/datetime-format.ts';
import type {RemoteUtcDateTime} from '../../src/remote-agent/datetime.ts';
const parse=(s:string)=>parseRemoteUtcDateTime(s,1000);
it('Chrono AutoSi formats absent, millisecond, microsecond and nanosecond fractions exactly',()=>{
 for(const [input,expected] of [['2026-10-11T00:00:00Z','2026-10-11T00:00:00Z'],['2026-10-11T00:00:00.1Z','2026-10-11T00:00:00.100Z'],['2026-10-11T00:00:00.000001Z','2026-10-11T00:00:00.000001Z'],['2026-10-11T00:00:00.1234Z','2026-10-11T00:00:00.123400Z'],['2026-10-11T00:00:00.000000001Z','2026-10-11T00:00:00.000000001Z']] as const)assert.equal(formatRemoteUtcDateTime(parse(input)),expected);
});
it('UTC normalization and leap second representation round-trip without flattening',()=>{
 assert.equal(formatRemoteUtcDateTime(parse('2026-10-11T09:00:00+09:00')),'2026-10-11T00:00:00Z');
 for(const raw of ['2016-12-31T23:59:60Z','2016-12-31T23:59:60.500Z','2016-12-31T23:59:60.999999999Z']){const value=parse(raw);assert.equal(formatRemoteUtcDateTime(value),raw);assert.deepEqual(parse(formatRemoteUtcDateTime(value)),value);}
});
it('expanded signed years and pre-epoch UTC seconds use Chrono year formatting',()=>{
 for(const raw of ['0000-01-01T00:00:00Z','-0001-01-01T00:00:00Z','+10000-01-01T00:00:00Z','-262143-01-01T00:00:00Z','+262142-12-31T23:59:59.999999999Z','1969-12-31T23:59:59.001Z'])assert.equal(formatRemoteUtcDateTime(parse(raw)),raw);
});
it('passive datetime capture rejects getters proxies and invalid bigint or leap representations',()=>{
 let hooks=0;const getter={get seconds(){hooks++;return 0n;},nanosecond:0n};assert.throws(()=>formatRemoteUtcDateTime(getter));
 const proxy=new Proxy({seconds:0n,nanosecond:0n},{get(){hooks++;return 0n;}});assert.throws(()=>formatRemoteUtcDateTime(proxy));assert.equal(hooks,0);
 for(const value of [{seconds:0n,nanosecond:1000000000n},{seconds:0n,nanosecond:-1n},{seconds:59n,nanosecond:2000000000n},{seconds:8640000000001n,nanosecond:0n},{seconds:0,nanosecond:0n}])assert.throws(()=>formatRemoteUtcDateTime(value as RemoteUtcDateTime));
});
