import {it} from 'node:test';import assert from 'node:assert/strict';
import {HistoryPollState,historyMessageWatermark as mark,type HistoryBatchItem} from '../../../src/runtime/history-poll/state.ts';
import {runHistoryPollCycle,runBegunHistoryPollCycle,runHistoryGapRecovery,HistoryPollRunError,type HistoryPollIo} from '../../../src/runtime/history-poll/runner.ts';
const row=(id:number):HistoryBatchItem<number>=>({watermark:mark(BigInt(id),BigInt(id)),item:{kind:'Candidate',value:id}});
function fixture(rows:HistoryBatchItem<number>[]){const calls:string[]=[],won=new Set<number>();const io:{-readonly [K in keyof HistoryPollIo<HistoryBatchItem<number>,number,number>]:HistoryPollIo<HistoryBatchItem<number>,number,number>[K]}={async fetch(c,n){calls.push(`fetch:${c}:${n}`);return rows;},adapt(p){calls.push('adapt');return p;},async claim(v,p){calls.push(`claim:${v}:${p}`);if(won.has(v))return {kind:'Lost'};won.add(v);return {kind:'Won',admitted:v};},async process(v){calls.push(`process:${v}`);}};return {io,calls,won};}
const stage=(name:string)=>(e:unknown)=>e instanceof HistoryPollRunError&&e.stage===name;
it('fixed window adapts all first, claims oldest-first and commits only after every processed item',async()=>{
 const s=new HistoryPollState(),f=fixture([row(3),row(2),row(1)]),o=await runHistoryPollCycle(s,9n,2n,f.io);assert.deepEqual(f.calls,['fetch:9:10','adapt','adapt','adapt','claim:1:Discard','claim:2:Process','process:2','claim:3:Process','process:3']);assert.deepEqual(o,{phase:'Prime',fetched:3,noClaim:0,claimAttempted:3,claimWon:3,discarded:1,processed:2});assert.deepEqual(s.watermark(9n),mark(3n,3n));
});
it('fetch failure retains original prime boundary and retry does not discard newer arrival',async()=>{
 const s=new HistoryPollState(),f=fixture([row(3)]),original=f.io.fetch;f.io.fetch=async()=>{throw Error('network');};await assert.rejects(runHistoryPollCycle(s,1n,2n,f.io),stage('Source'));f.io.fetch=original;const o=await runHistoryPollCycle(s,1n,100n,f.io);assert.equal(o.processed,1);assert.deepEqual(s.watermark(1n),mark(3n,3n));
});
it('oversized source is rejected before adaptation or any claim',async()=>{
 const s=new HistoryPollState(),f=fixture(Array.from({length:11},(_,i)=>row(i+1)));await assert.rejects(runHistoryPollCycle(s,1n,0n,f.io),stage('State'));assert.deepEqual(f.calls,['fetch:1:10']);assert.equal(s.isPrimed(1n),false);
});
it('adaptation failure anywhere prevents all durable claims and cursor movement',async()=>{
 const s=new HistoryPollState(),f=fixture([row(2),row(1)]);f.io.adapt=p=>{if(p.watermark!.messageId===1n)throw Error('bad payload');return p;};await assert.rejects(runHistoryPollCycle(s,1n,0n,f.io),stage('Adaptation'));assert.equal(f.won.size,0);assert.equal(s.watermark(1n),null);
});
it('claim failure leaves cursor while retry suppresses already processed older message via durable claim result',async()=>{
 const s=new HistoryPollState(),f=fixture([row(2),row(1)]),claim=f.io.claim;let fail=true;f.io.claim=async(v,p)=>{if(v===2&&fail)throw Error('db');return claim(v,p);};await assert.rejects(runHistoryPollCycle(s,1n,0n,f.io),stage('Claim'));assert.equal(s.watermark(1n),null);fail=false;await runHistoryPollCycle(s,1n,20n,f.io);assert.equal(f.calls.filter(x=>x==='process:1').length,1);assert.equal(f.calls.filter(x=>x==='process:2').length,1);
});
it('process failure leaves cursor uncommitted and keeps claim disposition opaque',async()=>{
 const s=new HistoryPollState(),f=fixture([row(1)]);f.io.process=async()=>{throw Error('unknown action');};await assert.rejects(runHistoryPollCycle(s,1n,0n,f.io),stage('Process'));assert.equal(s.watermark(1n),null);assert.ok(f.won.has(1));const o=await runHistoryPollCycle(s,1n,3n,f.io);assert.equal(o.claimWon,0);assert.equal(o.processed,0);
});
it('stale commit reports Commit error after already completed processing without undo or replay',async()=>{
 const s=new HistoryPollState(),cycle=s.begin(1n,0n),other=s.propose(cycle,[row(8)]),f=fixture([row(1)]);f.io.process=async()=>{s.commit(1n,other.commitToken);};await assert.rejects(runBegunHistoryPollCycle(s,1n,cycle,f.io),stage('Commit'));assert.deepEqual(s.watermark(1n),mark(8n,8n));assert.equal(f.won.size,1);
});
it('ignored and invalid-position rows expose no payload to claim',async()=>{
 const f=fixture([{watermark:mark(2n,2n),item:{kind:'Ignore'}},{watermark:null,item:{kind:'Candidate',value:1}}]),s=new HistoryPollState(),o=await runHistoryPollCycle(s,1n,0n,f.io);assert.equal(o.noClaim,2);assert.equal(o.claimAttempted,0);assert.deepEqual(s.watermark(1n),mark(2n,2n));
});
it('gap recovery includes the floor, ignores older items, and does not use prime discard policy',async()=>{
 const f=fixture([row(3),row(2),row(1)]),o=await runHistoryGapRecovery(1n,mark(2n,2n)!,f.io);assert.equal(o.coverage,'Reached');assert.equal(o.noClaim,1);assert.equal(o.processed,2);assert.deepEqual(f.calls.filter(x=>x.startsWith('claim:')),['claim:2:Process','claim:3:Process']);
});
it('full page above gap floor stays Incomplete even when all its work processed',async()=>{
 const f=fixture(Array.from({length:10},(_,i)=>row(20-i))),o=await runHistoryGapRecovery(1n,mark(1n,1n)!,f.io);assert.equal(o.coverage,'Incomplete');assert.equal(o.processed,10);
});
it('ignored old position can prove coverage while missing positions on a full page cannot',async()=>{
 const f=fixture([{watermark:mark(1n,1n),item:{kind:'Ignore'}},...Array.from({length:9},(_,i)=>row(20-i))]);assert.equal((await runHistoryGapRecovery(1n,mark(5n,5n)!,f.io)).coverage,'Reached');const g=fixture(Array.from({length:10},()=>({watermark:null,item:{kind:'Ignore'}})));assert.equal((await runHistoryGapRecovery(1n,mark(1n,1n)!,g.io)).coverage,'Incomplete');
});
it('cross-channel begun cycle fails before fetching any unrelated channel',async()=>{
 const s=new HistoryPollState(),f=fixture([]);await assert.rejects(runBegunHistoryPollCycle(s,2n,s.begin(1n,0n),f.io));assert.deepEqual(f.calls,[]);
});
it('cancellation waits for actual pending fetch and retains exclusive IO ownership until joined',async()=>{
 const s=new HistoryPollState(),f=fixture([row(1)]),c=new AbortController(),reason=new Error('stop');let finish!:(rows:HistoryBatchItem<number>[])=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});f.io.fetch=async()=>{entered();return await new Promise(r=>{finish=r;});};let ended=false;const task=runHistoryPollCycle(s,1n,0n,f.io,c.signal).finally(()=>{ended=true;});const rejected=assert.rejects(task,e=>e===reason);await started;c.abort(reason);await Promise.resolve();assert.equal(ended,false);await assert.rejects(runHistoryPollCycle(s,1n,0n,f.io),/already owned/);await assert.rejects(runHistoryGapRecovery(1n,mark(1n,1n)!,f.io),/already owned/);finish([row(1)]);await rejected;assert.equal(s.watermark(1n),null);assert.equal(f.won.size,0);
});
it('preabort performs no fetch or prime-state mutation',async()=>{
 const s=new HistoryPollState(),f=fixture([]),c=new AbortController(),reason=new Error('stop');c.abort(reason);await assert.rejects(runHistoryPollCycle(s,1n,0n,f.io,c.signal),e=>e===reason);assert.deepEqual(f.calls,[]);assert.deepEqual(s.propose(s.begin(1n,99n),[]).nextWatermark,{micros:99n,messageId:0n});
});
it('malformed claim and nonvoid process are rejected without committing cursor',async()=>{
 for(const which of ['claim','process']){const s=new HistoryPollState(),f=fixture([row(1)]);if(which==='claim')f.io.claim=async()=>({kind:'Maybe'} as never);else f.io.process=async()=>123 as never;await assert.rejects(runHistoryPollCycle(s,1n,0n,f.io),stage(which==='claim'?'Claim':'Process'));assert.equal(s.watermark(1n),null);}
});
