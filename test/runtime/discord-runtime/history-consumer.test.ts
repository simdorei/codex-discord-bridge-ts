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
