import assert from 'node:assert/strict';import {test} from 'node:test';
import {RemoteRequestBudget as Budget,RemoteDeadlineError} from '../../src/remote-agent/request-budget.ts';
import {parseRemoteUtcDateTime as date} from '../../src/remote-agent/datetime.ts';
const p=(s:string)=>date(s,1000),billion=1000000000n;
test('one wall-clock snapshot becomes an exact monotonic deadline with nonmutating cap and clone',()=>{
 const now={seconds:100n,nanosecond:123456789n},end={seconds:160n,nanosecond:123456790n};const b=Budget.fromDeadline(end,now,1000n);now.seconds=10000n;end.seconds=-10000n;
 assert.equal(b.remaining(null,1000n),60n*billion+1n);assert.equal(b.remaining(10n,1000n),10n);assert.equal(b.remaining(0n,1000n),0n);assert.equal(b.remaining(null,1001n),60n*billion);
 const copy=b.clone();assert.equal(copy.remaining(null,2000n),b.remaining(null,2000n));
 assert.throws(()=>b.remaining(null,1000n+60n*billion+1n),(e:unknown)=>e instanceof RemoteDeadlineError&&e.kind==='Expired'&&e.message==='The local project request expired before execution.');
});
test('past and equal wall deadlines clamp to expired; a zero cap does not rescue expiry',()=>{
 for(const end of [{seconds:0n,nanosecond:0n},{seconds:1n,nanosecond:0n}]){const b=Budget.fromDeadline(end,{seconds:1n,nanosecond:0n},500n);assert.throws(()=>b.remaining(null,500n),RemoteDeadlineError);assert.throws(()=>b.remaining(0n,500n),RemoteDeadlineError);}
 const b=Budget.fromDeadline({seconds:1n,nanosecond:1n},{seconds:1n,nanosecond:0n},0n);assert.equal(b.remaining(null,0n),1n);assert.throws(()=>b.remaining(null,1n),RemoteDeadlineError);
});
test('Chrono leap corrections preserve same-day and cross-midnight source duration rules',()=>{
 const leap=p('2015-06-30T23:59:60.5Z');
 const before=p('2015-06-30T23:59:59Z'),next=p('2015-07-01T00:00:00Z');
 assert.equal(Budget.fromDeadline(leap,before,0n).remaining(null,0n),1500000000n);
 // NaiveDateTime subtraction is date duration plus time duration, without a
 // global leap-second table. These are the source's representational semantics.
 assert.throws(()=>Budget.fromDeadline(next,leap,0n).remaining(null,0n),RemoteDeadlineError);
 const after=p('2015-07-01T00:00:01Z');assert.equal(Budget.fromDeadline(after,leap,0n).remaining(null,0n),500000000n);
 const sameDayLeap=p('1970-01-01T00:00:60.5Z'),sameDayAfter=p('1970-01-01T00:01:01Z');assert.equal(Budget.fromDeadline(sameDayAfter,sameDayLeap,0n).remaining(null,0n),1500000000n);
});
test('wide Chrono dates retain integer nanoseconds and never narrow to a JS timer duration',()=>{
 const b=Budget.fromDeadline(p('+262142-12-31T23:59:59.999999999Z'),p('-262143-01-01T00:00:00Z'),0n);
 assert.ok(b.remaining(null,0n)>BigInt(Number.MAX_SAFE_INTEGER));assert.equal(b.remaining(5000000n,0n),5000000n);
});
test('passive clock capture rejects getters/proxies and malformed date representations without hooks',()=>{
 let hooks=0;const valid={seconds:0n,nanosecond:0n};
 assert.throws(()=>Budget.fromDeadline({get seconds(){hooks++;return 1n;},nanosecond:0n},valid,0n),TypeError);
 const proxy=new Proxy(valid,{get(){hooks++;return 0n;},getOwnPropertyDescriptor(){hooks++;return undefined;}});assert.throws(()=>Budget.fromDeadline(proxy,valid,0n),TypeError);assert.equal(hooks,0);
 for(const end of [{seconds:0n,nanosecond:1000000000n},{seconds:0n,nanosecond:-1n},{seconds:59n,nanosecond:2000000000n},{seconds:8640000000001n,nanosecond:0n}])assert.throws(()=>Budget.fromDeadline(end,valid,0n),TypeError);
 const b=Budget.fromDeadline({seconds:1n,nanosecond:0n},valid,10n);assert.throws(()=>b.remaining(null,9n),RangeError);assert.throws(()=>b.remaining(-1n,10n),RangeError);
});
test('default real clocks produce a usable budget and cancellation wording stays source-exact',()=>{
 const now=Date.now(),end={seconds:BigInt(Math.floor(now/1000))+60n,nanosecond:BigInt(now%1000)*1000000n},b=Budget.fromDeadline(end);const remaining=b.remaining();assert.ok(remaining>0n&&remaining<=60n*billion);
 const e=new RemoteDeadlineError('Cancelled');assert.equal(e.message,'The local project request was cancelled with its bridge connection.');assert.equal(e.kind,'Cancelled');
});
