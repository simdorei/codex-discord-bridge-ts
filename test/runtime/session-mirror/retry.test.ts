import assert from 'node:assert/strict';
import {it} from 'node:test';
import {SessionMirrorRetryState} from '../../../src/runtime/session-mirror/retry.ts';
const SECOND=1_000_000_000n,MAX=((1n<<64n)-1n)*SECOND+999_999_999n;
it('failure backoff is 1,2,4,8,16,30 seconds and stays capped',()=>{
 const s=new SessionMirrorRetryState();for(const delay of [1n,2n,4n,8n,16n,30n,30n,30n])assert.equal(s.onFailure(0n,'same').retryAfterNanoseconds,delay*SECOND);
});
it('unchanged errors report at exactly sixty seconds with accumulated count',()=>{
 const s=new SessionMirrorRetryState();assert.deepEqual(s.onFailure(10n*SECOND,'e').report,{count:1n,error:'e'});
 assert.equal(s.onFailure(70n*SECOND-1n,'e').report,null);assert.deepEqual(s.onFailure(70n*SECOND,'e').report,{count:3n,error:'e'});
 assert.equal(s.onFailure(130n*SECOND-1n,'e').report,null);assert.deepEqual(s.onFailure(130n*SECOND,'e').report,{count:5n,error:'e'});
});
it('changed message resets count/backoff and reports immediately, including empty string',()=>{
 const s=new SessionMirrorRetryState();s.onFailure(0n,'a');s.onFailure(1n,'a');const d=s.onFailure(2n,'');assert.deepEqual(d,{retryAfterNanoseconds:SECOND,report:{count:1n,error:''}});
 assert.equal(s.onFailure(3n,'').report,null);assert.equal(s.onFailure(4n,'a').report?.count,1n);
});
it('success fully resets state and returns normal polling delay',()=>{
 const s=new SessionMirrorRetryState();for(let i=0;i<10;i++)s.onFailure(0n,'e');assert.equal(s.onSuccess(),SECOND);assert.equal(s.onSuccess(),SECOND);
 assert.deepEqual(s.onFailure(1n,'e'),{retryAfterNanoseconds:SECOND,report:{count:1n,error:'e'}});
});
it('clock regression does not report early and duration deadline saturates',()=>{
 const s=new SessionMirrorRetryState();s.onFailure(100n*SECOND,'e');assert.equal(s.onFailure(1n,'e').report,null);
 const edge=new SessionMirrorRetryState();edge.onFailure(MAX-1n,'e');assert.equal(edge.onFailure(MAX-1n,'e').report,null);assert.equal(edge.onFailure(MAX,'e').report?.count,3n);assert.equal(edge.onFailure(MAX,'e').report?.count,4n);
});
it('separate states are isolated and decisions/reports are immutable',()=>{
 const a=new SessionMirrorRetryState(),b=new SessionMirrorRetryState();a.onFailure(0n,'e');a.onFailure(0n,'e');const d=b.onFailure(0n,'e');assert.equal(d.report?.count,1n);assert.equal(Object.isFrozen(d),true);assert.equal(Object.isFrozen(d.report),true);
 assert.throws(()=>Object.assign(d,{retryAfterNanoseconds:0n}),TypeError);
});
it('invalid clocks/text fail before state mutation and never coerce objects',()=>{
 const s=new SessionMirrorRetryState();for(const n of [-1n,MAX+1n,0,NaN,null])assert.throws(()=>s.onFailure(n as bigint,'e'),RangeError);
 let calls=0;assert.throws(()=>s.onFailure(0n,{toString(){calls++;return 'e';}} as unknown as string),TypeError);assert.equal(calls,0);
 assert.throws(()=>s.onFailure(0n,'\ud800'),TypeError);assert.equal(s.onFailure(0n,'e').report?.count,1n);
});
