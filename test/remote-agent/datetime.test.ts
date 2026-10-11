import assert from 'node:assert/strict';import {test} from 'node:test';
import {parseRemoteUtcDateTime as parse} from '../../src/remote-agent/datetime.ts';
const p=(s:string)=>parse(s,12000000);
test('Chrono Serde UTC examples preserve exact offset conversion and epoch',()=>{
 assert.deepEqual(p('1970-01-01T00:00:00Z'),{seconds:0n,nanosecond:0n});
 assert.deepEqual(p('1969-12-31T23:59:59.999999999Z'),{seconds:-1n,nanosecond:999999999n});
 assert.deepEqual(p('2014-07-24T13:57:06+01:23'),p('2014-07-24T12:34:06Z'));
 assert.deepEqual(p('1970-01-01T09:00:00+09:00'),p('1970-01-01T00:00:00Z'));
 assert.ok(Object.isFrozen(p('1970-01-01T00:00:00Z')));
});
test('relaxed numeric widths, component whitespace, UTC and colon-free zones match source grammar',()=>{
 const expected=p('2012-12-12T12:12:12Z');
 for(const s of ['2012-12-12 12:12:12Z','2012-  12-12T12:  12:12Z','2012-12-12t12:12:12utc','2012-12-12T12:12:12+0000','2012-12-12T12:12:12+00::: \t00','\u0085 2012 -12 -12T 12 :12 :12 UTC\u0085'])assert.deepEqual(p(s),expected,s);
 assert.deepEqual(p('1-2-3T4:5:6Z'),p('0001-02-03T04:05:06Z'));
 assert.deepEqual(p('1970-1-1T0:0:0−00:00'),p('1970-01-01T00:00:00Z'));
});
test('nanoseconds truncate additional digits and retain source leap-second representation',()=>{
 assert.deepEqual(p('1970-01-01T00:00:00.1Z'),{seconds:0n,nanosecond:100000000n});
 assert.deepEqual(p('1970-01-01T00:00:00.123456789987Z'),{seconds:0n,nanosecond:123456789n});
 assert.deepEqual(p('1970-01-01T00:00:60.5Z'),{seconds:59n,nanosecond:1500000000n});
 assert.deepEqual(p('1970-01-01T09:00:60.5+0900'),{seconds:59n,nanosecond:1500000000n});
 assert.notDeepEqual(p('1970-01-01T00:00:60Z'),p('1970-01-01T00:01:00Z'));
});
test('signed expanded years, Gregorian year zero and exact local/UTC range boundaries',()=>{
 assert.deepEqual(p('+10000-01-01T00:00:00Z'),p('+010000-1-1T0:0:0UTC'));
 assert.deepEqual(p('-0000-01-01T00:00:00Z'),p('0000-01-01T00:00:00Z'));
 assert.equal(p('0000-02-29T00:00:00Z').seconds-p('0000-02-28T00:00:00Z').seconds,86400n);
 assert.ok(p('-262143-01-01T00:00:00Z').seconds<0n);assert.ok(p('+262142-12-31T23:59:60.9Z').seconds>0n);
 for(const s of ['10000-01-01T00:00:00Z','-262144-12-31T23:59:59Z','+262143-01-01T00:00:00Z','-262143-01-01T00:00:00+00:01','+262142-12-31T23:59:59-00:01','+9223372036854775808-1-1T0:0:0Z'])assert.throws(()=>p(s),SyntaxError,s);
});
test('invalid Gregorian dates, times and offsets do not normalize through JavaScript Date',()=>{
 for(const s of ['1900-02-29T00:00:00Z','2026-02-30T00:00:00Z','2026-00-01T00:00:00Z','2026-13-01T00:00:00Z','2026-01-00T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:60:00Z','2026-01-01T00:00:61Z','2026-01-01T00:00:00+24:00','2026-01-01T00:00:00+00:60'])assert.throws(()=>p(s),SyntaxError,s);
 assert.ok(p('2000-02-29T00:00:00Z'));assert.ok(p('2026-01-01T00:00:00+23:59'));
});
test('whitespace placement and timezone tokens follow relaxed source rather than permissive Date.parse',()=>{
 for(const s of ['2026-01-01\t00:00:00Z','2026-01-01T00:00:00 .1Z','2026-01-01T00:00:00.Z','2026-01-01T00:00:00+ 00:00','2026-01-01T00:00:00+0:00','2026-01-01T00:00:00+00:0','2026-01-01T00:00:00UTC+00:00','2026-01-01T00:00:00GMT','2026-01-01T00:00:00','\ufeff2026-01-01T00:00:00Z','2026-01-01T00:00:00Z\ufeff','−0001-1-1T0:0:0Z','+ 1-1-1T0:0:0Z'])assert.throws(()=>p(s),SyntaxError,s);
});
test('byte cap bounds arbitrarily long source-valid whitespace and fractional input',()=>{
 const s='\u0085'.repeat(1000)+'1970-1-1T0:0:0.'+'0'.repeat(1000)+'Z';assert.deepEqual(parse(s,Buffer.byteLength(s)),{seconds:0n,nanosecond:0n});assert.throws(()=>parse(s,Buffer.byteLength(s)-1),RangeError);
 for(const max of [0,-1,12000001,NaN])assert.throws(()=>parse('1970-1-1T0:0:0Z',max),RangeError);
});
