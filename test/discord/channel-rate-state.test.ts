import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DiscordChannelRateState,type ChannelRateHeaders,type RateClock} from '../../src/discord/channel-rate-state.ts';
class Clock implements RateClock{
 value=0;next=0;readonly timers=new Map<number,{at:number;run:()=>void}>();now(){return this.value;}schedule(at:number,run:()=>void){const id=++this.next;this.timers.set(id,{at,run});return()=>{this.timers.delete(id);};}
 advance(ms:number){const end=this.value+ms;for(let i=0;i<1000;i++){const item=[...this.timers].sort((a,b)=>a[1].at-b[1].at)[0];if(item===undefined||item[1].at>end){this.value=end;return;}this.value=item[1].at;this.timers.delete(item[0]);item[1].run();}throw new Error('Timer spin');}
}
const signal=()=>new AbortController().signal;
const message=(id=1)=>`channels/${id}/messages`,typing=(id=1)=>`channels/${id}/typing`;
const h=(bucket:string,remaining:number,resetAtMs:number):ChannelRateHeaders=>({bucket:Buffer.from(bucket),limit:5,remaining,resetAtMs});
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
test('unknown endpoint queue serializes message and typing for the same channel',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(50,clock),a=await rate.acquire(message(),signal());let granted=false;const pending=rate.acquire(typing(),signal()).then(p=>{granted=true;return p;});await flush();assert.equal(granted,false);assert.equal(rate.pendingCount,1);a.complete(null);const b=await pending;assert.equal(rate.activeCount,1);b.complete(null);assert.equal(rate.globalRemaining,48);await rate.close();assert.equal(clock.timers.size,0);
});
test('global limit pauses independent channels until first-request one-second window resets',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(2,clock),a=await rate.acquire(message(1),signal()),b=await rate.acquire(message(2),signal());let granted=false;const pending=rate.acquire(message(3),signal()).then(p=>{granted=true;return p;});a.complete(null);b.complete(null);assert.equal(rate.globalRemaining,0);clock.advance(999);await flush();assert.equal(granted,false);clock.advance(1);const c=await pending;assert.equal(rate.globalRemaining,1);c.release();assert.equal(rate.globalRemaining,2);await rate.close();
});
test('queued cancellation consumes no slot; granted cancellation refunds only once',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(3,clock),a=await rate.acquire(message(),signal()),abort=new AbortController(),reason=new Error('cancel');const pending=rate.acquire(message(),abort.signal),rejected=assert.rejects(pending,e=>e===reason);abort.abort(reason);await rejected;assert.equal(rate.pendingCount,0);assert.equal(rate.globalRemaining,2);a.release();a.release();assert.equal(rate.globalRemaining,3);assert.throws(()=>a.complete(null),/already completed/);await rate.close();
});
test('known exhausted bucket waits for reset without pretending remaining was replenished',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(50,clock),a=await rate.acquire(message(),signal());a.complete(h('bucket',0,500));let granted=false;const pending=rate.acquire(message(),signal()).then(p=>{granted=true;return p;});clock.advance(499);await flush();assert.equal(granted,false);clock.advance(1);const b=await pending;assert.equal(rate.activeCount,1);b.complete(h('bucket',4,1000));await rate.close();
});
test('same bucket is shared within one channel, while identical bucket bytes in another channel remain independent',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(50,clock);for(const path of [message(),typing(),message(2)]){const p=await rate.acquire(path,signal());p.complete(h('same',4,1000));}
 const a=await rate.acquire(message(),signal()),other=await rate.acquire(message(2),signal());let granted=false;const waiting=rate.acquire(typing(),signal()).then(p=>{granted=true;return p;});await flush();assert.equal(granted,false);assert.equal(rate.activeCount,2);a.complete(h('same',3,1000));const b=await waiting;b.complete(null);other.complete(null);await rate.close();
});
test('bucket remap partitions queued endpoint requests and lets the old bucket continue',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(50,clock);for(const path of [message(),typing()]){const p=await rate.acquire(path,signal());p.complete(h('old',4,1000));}
 const a=await rate.acquire(message(),signal());let moved=false;const movedPromise=rate.acquire(message(),signal()).then(p=>{moved=true;return p;}),oldPromise=rate.acquire(typing(),signal());a.complete(h('new',0,200));const old=await oldPromise;await flush();assert.equal(moved,false);clock.advance(200);const next=await movedPromise;assert.equal(rate.activeCount,2);next.complete(null);old.complete(null);await rate.close();
});
test('remapping into an in-flight bucket does not overwrite that bucket with stale response headers',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(50,clock);let p=await rate.acquire(message(),signal());p.complete(h('x',4,1000));p=await rate.acquire(typing(),signal());p.complete(h('y',4,1000));const a=await rate.acquire(message(),signal()),b=await rate.acquire(typing(),signal()),next=rate.acquire(message(),signal());a.complete(h('y',0,60000));b.complete(h('y',3,1000));const moved=await next;moved.complete(null);await rate.close();
});
test('close rejects queued work but waits for granted ownership and rejects further acquisition',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(50,clock),a=await rate.acquire(message(),signal()),reason=new Error('stop'),queued=rate.acquire(message(),signal()),rejected=assert.rejects(queued,e=>e===reason);let closed=false;const closure=rate.close(reason).then(()=>{closed=true;});await rejected;await flush();assert.equal(closed,false);await assert.rejects(rate.acquire(message(),signal()),e=>e===reason);a.release();await closure;assert.equal(rate.activeCount,0);assert.equal(clock.timers.size,0);
});
test('clock reset and six-hour cache cleanup leave new acquisition usable',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(50,clock),a=await rate.acquire(message(),signal());a.complete(h('old',0,100));clock.advance(6*60*60*1000);const b=await rate.acquire(message(),signal());b.complete(null);assert.equal(rate.activeCount,0);await rate.close();assert.equal(clock.timers.size,0);
});
test('malformed parsed headers do not consume permit; raw bucket bytes are snapshotted',async()=>{
 const clock=new Clock(),rate=new DiscordChannelRateState(50,clock),a=await rate.acquire(message(),signal());assert.throws(()=>a.complete({...h('b',1,1000),remaining:65536}));assert.equal(rate.activeCount,1);const bucket=new Uint8Array([0,255]);a.complete({bucket,limit:1,remaining:0,resetAtMs:10});bucket[0]=4;clock.advance(10);const b=await rate.acquire(message(),signal());b.complete(null);await rate.close();
});
