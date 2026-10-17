import {performance} from "node:perf_hooks";
import assert from "node:assert/strict";
import {test} from "node:test";
import {GenerationWatch} from "../../src/app-server/generation-watch.ts";
import {RestartBackoff,runRestartSupervisor,type RestartClock} from "../../src/app-server/restart-supervisor.ts";
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
class ManualClock implements RestartClock{
  time=0;readonly waits=new Set<{deadline:number;finish():void}>();readonly deadlines:number[]=[];
  now():number{return this.time;}
  waitUntil(deadline:number,signal:AbortSignal):Promise<void>{
    signal.throwIfAborted();this.deadlines.push(deadline);if(deadline<=this.time)return Promise.resolve();
    return new Promise((resolve,reject)=>{const cleanup=()=>{this.waits.delete(wait);signal.removeEventListener("abort",abort);};const abort=()=>{cleanup();reject(signal.reason);};const wait={deadline,finish(){cleanup();resolve();}};this.waits.add(wait);signal.addEventListener("abort",abort,{once:true});});
  }
  advance(ms:number):void{this.time+=ms;for(const wait of [...this.waits])if(wait.deadline<=this.time)wait.finish();}
}
test("restart delay follows the exact bounded source schedule and resets",()=>{const b=new RestartBackoff();assert.deepEqual(Array.from({length:8},()=>b.nextDelay()),[250,500,1000,2000,4000,5000,5000,5000]);b.reset();assert.equal(b.nextDelay(),250);});
test("duplicate and stale generation requests coalesce after a successful attempt",{timeout:3000},async()=>{
  const watch=new GenerationWatch(),shutdown=new AbortController(),attempts:bigint[]=[];const running=runRestartSupervisor(watch.subscribe(),shutdown.signal,async g=>{attempts.push(g);return true;},()=>{});
  for(let i=0;i<16;i++)watch.replace(1n);await tick();assert.deepEqual(attempts,[1n]);for(let i=0;i<16;i++)watch.replace(1n);await tick();assert.deepEqual(attempts,[1n]);watch.replace(2n);await tick();assert.deepEqual(attempts,[1n,2n]);watch.replace(1n);await tick();assert.deepEqual(attempts,[1n,2n]);shutdown.abort();await running;assert.equal(watch.receiverCount,0);
});
test("duplicate same-generation signals preserve the absolute 250ms retry deadline",{timeout:3000},async()=>{
  const watch=new GenerationWatch(7n),shutdown=new AbortController(),clock=new ManualClock();let attempts=0;const running=runRestartSupervisor(watch.subscribe(),shutdown.signal,async()=>{attempts++;return false;},()=>{},clock);await tick();assert.equal(attempts,1);clock.advance(100);
  for(let i=0;i<100;i++)watch.replace(7n);await tick();assert.ok(clock.deadlines.every(d=>d===250));clock.advance(149);await tick();assert.equal(attempts,1);clock.advance(1);await tick();assert.equal(attempts,2);assert.equal(clock.deadlines.at(-1),750);shutdown.abort();await running;assert.equal(clock.waits.size,0);assert.equal(watch.pendingWaiters,0);
});
test("new generation and a cleared request reset retry state",{timeout:3000},async()=>{
  const watch=new GenerationWatch(1n),shutdown=new AbortController(),clock=new ManualClock(),attempts:bigint[]=[];const running=runRestartSupervisor(watch.subscribe(),shutdown.signal,async g=>{attempts.push(g);return false;},()=>{},clock);await tick();clock.advance(250);await tick();assert.equal(clock.deadlines.at(-1),750);watch.replace(2n);await tick();assert.deepEqual(attempts,[1n,1n,2n]);assert.equal(clock.deadlines.at(-1),500);watch.replace(null);await tick();assert.equal(clock.waits.size,0);watch.replace(2n);await tick();assert.equal(clock.deadlines.at(-1),500);shutdown.abort();await running;
});
test("shutdown wakes a pending backoff without advancing time or starting another attempt",{timeout:3000},async()=>{
  const watch=new GenerationWatch(1n),shutdown=new AbortController(),clock=new ManualClock();let attempts=0;const running=runRestartSupervisor(watch.subscribe(),shutdown.signal,async()=>{attempts++;return false;},()=>{},clock);await tick();assert.equal(clock.waits.size,1);shutdown.abort();await running;assert.equal(clock.time,0);assert.equal(clock.waits.size,0);clock.advance(5000);await tick();assert.equal(attempts,1);
});
test("shutdown joins an already-running owned restart instead of canceling it",{timeout:3000},async()=>{
  const watch=new GenerationWatch(1n),shutdown=new AbortController();let finish!:(value:boolean)=>void,done=false;const running=runRestartSupervisor(watch.subscribe(),shutdown.signal,()=>new Promise(resolve=>{finish=resolve;}),()=>{}).then(()=>{done=true;});await tick();shutdown.abort();await tick();assert.equal(done,false);finish(false);await running;assert.equal(done,true);assert.equal(watch.receiverCount,0);
});
test("failed attempts preserve raw error and retry; reporter failure remains observable",{timeout:3000},async()=>{
  const watch=new GenerationWatch(1n),shutdown=new AbortController(),clock=new ManualClock(),sentinel={},reported:unknown[]=[];let attempts=0;const running=runRestartSupervisor(watch.subscribe(),shutdown.signal,async()=>{if(++attempts===1)throw sentinel;return true;},(g,error)=>{assert.equal(g,1n);reported.push(error);},clock);await tick();assert.equal(reported[0],sentinel);clock.advance(250);await tick();assert.equal(attempts,2);shutdown.abort();await running;
  const other=new GenerationWatch(1n),failure={};await assert.rejects(runRestartSupervisor(other.subscribe(),new AbortController().signal,async()=>{throw sentinel;},()=>{throw failure;}),error=>error instanceof AggregateError&&error.errors[0]===sentinel&&error.errors[1]===failure);assert.equal(other.receiverCount,0);
});
test("closed restart sender and preexisting shutdown release subscriptions without attempts",{timeout:3000},async()=>{
  const watch=new GenerationWatch(),shutdown=new AbortController();let attempts=0;const running=runRestartSupervisor(watch.subscribe(),shutdown.signal,async()=>{attempts++;return true;},()=>{});watch.close();await running;assert.equal(attempts,0);assert.equal(watch.receiverCount,0);const other=new GenerationWatch(1n);shutdown.abort();await runRestartSupervisor(other.subscribe(),shutdown.signal,async()=>{attempts++;return true;},()=>{});assert.equal(attempts,0);assert.equal(other.receiverCount,0);
});
test("invalid truthy attempt result cannot mark a generation settled",{timeout:3000},async()=>{
  const watch=new GenerationWatch(1n),shutdown=new AbortController(),clock=new ManualClock();let reports=0,attempts=0;const running=runRestartSupervisor(watch.subscribe(),shutdown.signal,async()=>{attempts++;return {} as boolean;},(_g,error)=>{assert.ok(error instanceof TypeError);reports++;},clock);await tick();clock.advance(250);await tick();assert.equal(attempts,2);assert.equal(reports,2);shutdown.abort();await running;
});

test("native retry timer never completes before its absolute 250ms deadline",{timeout:3000},async()=>{
  const watch=new GenerationWatch(1n),shutdown=new AbortController(),times:number[]=[];const running=runRestartSupervisor(watch.subscribe(),shutdown.signal,async()=>{times.push(performance.now());if(times.length===2){shutdown.abort();return true;}return false;},()=>{});await running;assert.equal(times.length,2);assert.ok(times[1]!-times[0]!>=250);
});
test("invalid monotonic clock stops safely and releases its owned receiver",{timeout:3000},async()=>{
  const watch=new GenerationWatch(1n);await assert.rejects(runRestartSupervisor(watch.subscribe(),new AbortController().signal,async()=>false,()=>{},{now:()=>NaN,waitUntil:async()=>{throw new Error("must not sleep");}}),/monotonic/);assert.equal(watch.receiverCount,0);
});
