import {it} from 'node:test';import assert from 'node:assert/strict';import {setTimeout as sleep} from 'node:timers/promises';
import {runHistoryConsumer} from '../../../src/runtime/discord-runtime/history-consumer.ts';import {GatewayIdentityTracker} from '../../../src/discord/gateway/identity.ts';import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';import {RuntimeGatewayIdentityConflictError} from '../../../src/runtime/discord-runtime/identity-wait.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
function owners(ready=true){const identity=new GatewayIdentityTracker(),gaps=new MessageGapTracker(),id=identity.subscribeIdentity(),conflict=identity.subscribeConflict(),rx=gaps.subscribe(),shutdown=new AbortController(),force=new AbortController();if(ready)identity.observe({userId:9n,applicationId:4n});return {identity,gaps,id,conflict,rx,shutdown,force,close(){shutdown.abort();identity.close();gaps.close();id.dispose();conflict.dispose();rx.dispose();}};}
it('history starts with gap recovery, immediate periodic cycle and another recovery in source order',async()=>{
 const f=owners(),order:string[]=[];try{await runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,1000,{async recover(identity){assert.equal(identity.userId,9n);order.push('gap');if(order.length===3)f.shutdown.abort();},async poll(){order.push('poll');}});assert.deepEqual(order,['gap','poll','gap']);assert.throws(()=>f.rx.snapshot(),/disposed/);}finally{f.close();}
});
it('disabled periodic polling still recovers new sticky gaps and never calls poll',async()=>{
 const f=owners(),first=deferred();let calls=0;try{const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){calls++;if(calls===1)first.resolve();else f.shutdown.abort();},async poll(){assert.fail();}});await first.promise;f.gaps.record(1n,{timestampMicros:1n,messageId:1n},'Full');await p;assert.equal(calls,2);}finally{f.close();}
});
it('identity conflict aborts active history operation but waits for actual cleanup',async()=>{
 const f=owners(),entered=deferred(),aborted=deferred(),release=deferred();let settled=false;try{
 const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,10,{async recover(_identity,signal){entered.resolve();await new Promise<void>(r=>signal.addEventListener('abort',()=>{aborted.resolve();r();},{once:true}));await release.promise;throw signal.reason;},async poll(){assert.fail();}});void p.then(()=>settled=true,()=>settled=true);const check=assert.rejects(p,RuntimeGatewayIdentityConflictError);await entered.promise;f.identity.observe({userId:10n,applicationId:5n});await aborted.promise;assert.equal(settled,false);release.resolve();await check;assert.throws(()=>f.rx.snapshot(),/disposed/);
 }finally{release.resolve();f.close();}
});
it('shutdown before identity performs no history IO and disposes its owned receiver',async()=>{
 const f=owners(false);try{f.shutdown.abort();await runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,10,{async recover(){assert.fail();},async poll(){assert.fail();}});assert.throws(()=>f.rx.snapshot(),/disposed/);}finally{f.close();}
});
it('closed gap producer is fatal outside shutdown rather than silently disabling recovery',async()=>{
 const f=owners();try{f.gaps.close();await assert.rejects(runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){},async poll(){assert.fail();}}),/message-gap/);}finally{f.close();}
});
it('lagged gap hint triggers snapshot recovery without concurrent operations',async()=>{
 const f=owners(),entered=deferred(),release=deferred();let calls=0,active=0,max=0;try{const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){active++;max=Math.max(max,active);try{if(++calls===1){entered.resolve();await release.promise;}else f.shutdown.abort();}finally{active--;};},async poll(){assert.fail();}});await entered.promise;for(let i=1;i<=30;i++)f.gaps.record(1n,{timestampMicros:1n,messageId:BigInt(i)},'Full');release.resolve();await p;assert.equal(calls,2);assert.equal(max,1);assert.equal(active,0);}finally{release.resolve();f.close();}
});
it('slow periodic operation remains serial and recovers gaps before next periodic work',async()=>{
 const f=owners();let active=0,max=0,polls=0;const order:string[]=[];try{await runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,10,{async recover(){order.push('gap');},async poll(){active++;max=Math.max(max,active);try{polls++;order.push('poll');if(polls===1){await sleep(35);f.gaps.record(1n,{timestampMicros:1n,messageId:1n},'Full');}if(polls===3)f.shutdown.abort();}finally{active--;}}});assert.equal(max,1);assert.equal(polls,3);for(let i=1;i<order.length;i++)if(order[i]==='poll')assert.equal(order[i-1],'gap');}finally{f.close();}
});
it('periodic error propagates with no false completion and releases owned receiver',async()=>{
 const f=owners(),error=new Error('periodic failed');try{await assert.rejects(runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,10,{async recover(){},async poll(){throw error;}}),e=>e===error);assert.throws(()=>f.rx.snapshot(),/disposed/);}finally{f.close();}
});

import {historyCapacityRetryDelay} from '../../../src/runtime/discord-runtime/history-consumer.ts';
import {historyRetryClock,waitHistoryCondition as until} from '../../helpers/history-retry-clock.ts';
const capacity=Object.freeze({retryCapacity:true}),complete=Object.freeze({retryCapacity:false});
it('capacity wake is positive, capped, constant-space and serial with periodic polling disabled',async()=>{
 const f=owners(),c=historyRetryClock();let calls=0,active=0,max=0;const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){active++;max=Math.max(max,active);await Promise.resolve();calls++;active--;return capacity;},async poll(){assert.fail('retry called poll');}},c.clock);
 try{let at=0;for(const delay of [1000,2000,4000,8000,16000,30000,30000,30000]){await until(()=>c.active===1);assert.equal(c.deadlines.at(-1),at+delay);assert.equal(calls,c.deadlines.length);at+=delay;c.advance(at);await until(()=>c.active===1&&c.deadlines.at(-1)!==at);}
  assert.equal(max,1);assert.equal(active,0);assert.equal(c.maximum,1);assert.equal(historyCapacityRetryDelay(Number.MAX_SAFE_INTEGER),30000);for(const bad of [-1,NaN,1.5])assert.throws(()=>historyCapacityRetryDelay(bad));
 }finally{f.shutdown.abort();await p;assert.equal(c.active,0);f.close();}
});
it('gap hint outranks due retry and cannot postpone an earlier capacity deadline',async()=>{
 const f=owners(),c=historyRetryClock();let calls=0;const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){calls++;return capacity;},async poll(){assert.fail();}},c.clock);
 try{await until(()=>c.active===1);c.advance(100);f.gaps.record(1n,{timestampMicros:1n,messageId:1n},'Full');await until(()=>calls===2&&c.active===1);assert.equal(c.deadlines.at(-1),1000);
  c.advance(1000);f.gaps.record(2n,{timestampMicros:1n,messageId:2n},'Full');await until(()=>calls===3&&c.active===1);assert.equal(c.deadlines.at(-1),3000);assert.equal(c.maximum,1);
 }finally{f.shutdown.abort();await p;f.close();}
});
it('a pass without proved capacity clears the wake and resets the next backoff',async()=>{
 const f=owners(),c=historyRetryClock();let calls=0;const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){return ++calls===2?complete:capacity;},async poll(){assert.fail();}},c.clock);
 try{await until(()=>c.active===1);c.advance(1000);await until(()=>calls===2);await sleep(10);assert.equal(c.active,0);c.advance(1500);f.gaps.record(1n,{timestampMicros:1n,messageId:1n},'Full');await until(()=>c.active===1);assert.equal(c.deadlines.at(-1),2500);
 }finally{f.shutdown.abort();await p;f.close();}
});
for(const mode of ['shutdown','force','conflict'] as const)it(`${mode} cancels and joins a capacity sleep and disposes the receiver`,async()=>{
 const f=owners(),c=historyRetryClock(),reason=Error('force history');let calls=0;const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){calls++;return capacity;},async poll(){assert.fail();}},c.clock),check=mode==='shutdown'?p:assert.rejects(p,mode==='force'?(e:unknown)=>e===reason:RuntimeGatewayIdentityConflictError);
 try{await until(()=>c.active===1);if(mode==='shutdown')f.shutdown.abort();else if(mode==='force')f.force.abort(reason);else f.identity.observe({applicationId:5n,userId:10n});await check;assert.equal(c.active,0);assert.equal(calls,1);assert.throws(()=>f.rx.snapshot(),/disposed/);}finally{f.close();await check;}
});
it('earlier periodic deadline runs before a later capacity wake without concurrent IO',async()=>{
 const f=owners(),c=historyRetryClock();let recoveries=0,polls=0;const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,500,{async recover(){recoveries++;return capacity;},async poll(){polls++;}},c.clock);
 try{await until(()=>c.active===1);assert.equal(polls,1);assert.equal(recoveries,2);assert.equal(c.deadlines.at(-1),500);c.advance(500);await until(()=>polls===2&&c.active===1);assert.equal(c.deadlines.at(-1),1000);assert.equal(c.maximum,1);
 }finally{f.shutdown.abort();await p;f.close();}
});
it('losing timer cleanup is joined before the next gap operation starts',async()=>{
 const f=owners(),entered=deferred(),aborted=deferred(),release=deferred();let calls=0;
 const clock={now:()=>0,sleepUntil:async(_at:number,signal:AbortSignal)=>{entered.resolve();await new Promise<void>(r=>signal.addEventListener('abort',()=>{aborted.resolve();r();},{once:true}));await release.promise;throw signal.reason;}};
 const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){calls++;return calls===1?capacity:complete;},async poll(){assert.fail();}},clock);
 try{await entered.promise;f.gaps.record(1n,{timestampMicros:1n,messageId:1n},'Full');await aborted.promise;assert.equal(calls,1);release.resolve();await until(()=>calls===2);}finally{release.resolve();f.shutdown.abort();await p;f.close();}
});
it('consumer captures clock functions and rejects active or unfrozen dispositions',async()=>{
 for(const result of [{retryCapacity:true},Object.freeze({get retryCapacity():boolean{return assert.fail('active disposition');}}),new Proxy(complete,{getOwnPropertyDescriptor(){return assert.fail('proxy disposition');}})]){
  const f=owners();try{await assert.rejects(runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){return result;},async poll(){assert.fail();}}),TypeError);}finally{f.close();}
 }
 const f=owners(),c=historyRetryClock(),source={...c.clock};let calls=0;const p=runHistoryConsumer(f.rx,f.id,f.conflict,f.shutdown.signal,f.force.signal,null,{async recover(){calls++;return capacity;},async poll(){assert.fail();}},source);
 try{await until(()=>c.active===1);source.now=()=>assert.fail('replaced now');source.sleepUntil=async()=>assert.fail('replaced sleep');c.advance(1000);await until(()=>calls===2&&c.active===1);assert.equal(c.deadlines.at(-1),3000);}finally{f.shutdown.abort();await p;f.close();}
});
