import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire,syncBuiltinESMExports} from 'node:module';
import {Worker as NativeWorker,type WorkerOptions} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';

test('937 simultaneous native lanes: bounded admission, FIFO, cancellation and actual exit', {timeout:60000},async()=>{
 const OriginalWorker=NativeWorker;
 const constructors:string[]=[],exits:string[]=[],results:string[]=[],require=createRequire(import.meta.url),builtin=require('node:worker_threads') as {Worker:typeof NativeWorker};
 class ObservedWorker extends OriginalWorker{
  constructor(url:string|URL,options?:WorkerOptions){super(url,options);const id=(options?.workerData as {id?:string}|undefined)?.id;
   if(typeof id!=='string')throw new Error('Worker requires exact synthetic ID');constructors.push(id);
   this.once('exit',()=>exits.push(id));this.on('message',()=>{if(id!=='probe')results.push(id);});
  }
 }
 builtin.Worker=ObservedWorker;syncBuiltinESMExports();
 const {OwnedWorkerSlot,OwnedWorkerBudgetError,OwnedWorkerTimeoutError,ownedWorkerUsage,OWNED_WORKER_LIMITS}=await import('../../src/runtime/owned-worker-slot.ts');
 type Lane=keyof typeof OWNED_WORKER_LIMITS;type Queue='Control'|'Observation'|'Maintenance';
 type Outcome={ok:true;value:unknown}|{ok:false;error:unknown};
 type Job={id:string;lane:Lane;slot:InstanceType<typeof OwnedWorkerSlot>;shared:SharedArrayBuffer;controller:AbortController;pending:Promise<Outcome>;settlements:number};
 const jobs:Job[]=[],samples:{sequence:number;target:number;sent:number;received:number}[]=[],offered='x'.repeat(64),worker=new URL('../helpers/native-mixed-lane-worker.js',import.meta.url);
 const probe=new ObservedWorker(new URL('../helpers/native-mixed-lane-probe.js',import.meta.url),{workerData:{id:'probe'}});
 probe.on('message',(m:{sequence:number;target:number;sent:number})=>samples.push({...m,received:performance.now()}));
 const probeJoined=new Promise<void>((resolve,reject)=>{probe.once('exit',code=>code===0?resolve():reject(new Error('Probe exit')));probe.once('error',reject);});
 const lanes:Lane[]=['Background','Control','Observation','Discovery','Maintenance'],queues:Queue[]=['Control','Observation','Maintenance'];
 const full={Background:3,Control:1,Observation:2,Discovery:1,Maintenance:1},zero={Background:0,Control:0,Observation:0,Discovery:0,Maintenance:0};
 const pause=()=>new Promise<void>(r=>setTimeout(r,5));
 async function until(check:()=>boolean){const deadline=performance.now()+15000;while(!check()){assert.ok(performance.now()<deadline,'15000ms condition guard');await pause();}}
 function submit(id:string,lane:Lane,timeout:number,queued=false):Job{
  const slot=new OwnedWorkerSlot(lane),shared=new SharedArrayBuffer(16),controller=new AbortController();
  const job={id,lane,slot,shared,controller,pending:Promise.resolve({ok:true,value:null} as Outcome),settlements:0};jobs.push(job);
  const data={id,shared,offered};let pending:Promise<unknown>;
  if(!queued)pending=slot.run(worker,data,timeout,controller.signal);
  else if(lane==='Control')pending=slot.runControlCompletion(worker,data,timeout,controller.signal);
  else if(lane==='Observation')pending=slot.runObservationCompletion(worker,data,timeout,controller.signal);
  else pending=slot.runMaintenanceRead(worker,data,timeout,controller.signal);
  job.pending=pending.then(value=>{job.settlements++;return {ok:true,value};},error=>{job.settlements++;return {ok:false,error};});return job;
 }
 const started=(j:Job)=>Atomics.load(new Int32Array(j.shared),1)===1;
 function release(j:Job,exit=true){const a=new Int32Array(j.shared);Atomics.store(a,0,1);Atomics.notify(a,0);if(exit){Atomics.store(a,3,1);Atomics.notify(a,3);}}
 async function rejected(j:Job,kind:typeof OwnedWorkerBudgetError|typeof OwnedWorkerTimeoutError){const result=await j.pending;assert.equal(result.ok,false);if(!result.ok)assert.ok(result.error instanceof kind);}
 async function success(j:Job){release(j);assert.deepEqual(await j.pending,{ok:true,value:{id:j.id,offeredBytes:64}});await j.slot.join();assert.ok(exits.includes(j.id));}
 function unconstructed(list:Job[]){for(const j of list){assert.equal(constructors.includes(j.id),false,j.id);assert.equal(started(j),false,j.id);assert.equal(exits.includes(j.id),false,j.id);}}
 let summary:Record<string,unknown>|undefined;
 try{
  assert.deepEqual(ownedWorkerUsage(),zero);assert.deepEqual(OWNED_WORKER_LIMITS,full);
  const held:Job[]=[];for(const lane of lanes)for(let n=0;n<full[lane];n++)held.push(submit(`held-${lane}-${n}`,lane,lane==='Background'&&n===0?10000:30000));
  await until(()=>held.every(started));assert.deepEqual(ownedWorkerUsage(),full);assert.deepEqual(constructors.filter(x=>x!=='probe'),held.map(j=>j.id));
  const removed:Job[]=[];for(const lane of queues)for(let n=0;n<(lane==='Maintenance'?2:128);n++)removed.push(submit(`removed-${lane}-${n}`,lane,n===0?3000:30000,true));
  const refused:Job[]=[];for(const lane of queues)refused.push(submit(`overflow-${lane}`,lane,15000,true));for(const lane of lanes)refused.push(submit(`ordinary-saturated-${lane}`,lane,15000));
  await Promise.all(refused.map(j=>rejected(j,OwnedWorkerBudgetError)));unconstructed([...removed,...refused]);assert.deepEqual(ownedWorkerUsage(),full);
  const expired=removed.filter(j=>j.id.endsWith('-0'));await Promise.all(expired.map(j=>rejected(j,OwnedWorkerTimeoutError)));
  const cancelled=removed.filter(j=>!expired.includes(j));for(const j of cancelled)j.controller.abort('synthetic-queued-cancel');
  for(const j of cancelled)assert.deepEqual(await j.pending,{ok:false,error:'synthetic-queued-cancel'});
  await Promise.all(removed.map(j=>j.slot.join()));unconstructed(removed);assert.deepEqual(ownedWorkerUsage(),full);assert.ok(held.every(j=>!exits.includes(j.id)));
  const live:Job[]=[];for(const lane of queues)for(let n=0;n<2;n++)live.push(submit(`live-${lane}-${n}`,lane,15000,true));
  const released=new Set<string>();
  for(const lane of queues){
   const owner=held.find(j=>j.lane===lane)!;released.add(owner.id);await success(owner);
   const [first,second]=live.filter(j=>j.lane===lane) as [Job,Job];await until(()=>started(first));assert.equal(started(second),false);unconstructed([second,...live.filter(j=>queues.indexOf(j.lane as Queue)>queues.indexOf(lane))]);
   const overtaker=submit(`ordinary-overtake-${lane}`,lane,15000);refused.push(overtaker);await rejected(overtaker,OwnedWorkerBudgetError);unconstructed([overtaker]);
   for(const j of held.filter(j=>!released.has(j.id))){assert.equal(exits.includes(j.id),false);assert.equal(Atomics.load(new Int32Array(j.shared),0),0);}
   await success(first);await until(()=>started(second));await success(second);
   assert.deepEqual(constructors.filter(id=>id.startsWith(`live-${lane}-`)),[first.id,second.id]);
  }
  const timed=held.find(j=>j.id==='held-Background-0')!,aborted=held.find(j=>j.id==='held-Background-1')!;
  aborted.controller.abort('synthetic-held-abort');assert.deepEqual(await aborted.pending,{ok:false,error:'synthetic-held-abort'});await rejected(timed,OwnedWorkerTimeoutError);
  assert.equal(timed.slot.busy,true);assert.equal(aborted.slot.busy,true);assert.equal(ownedWorkerUsage().Background,3);
  const replacement=submit('ordinary-before-exit','Background',15000);refused.push(replacement);await rejected(replacement,OwnedWorkerBudgetError);unconstructed([replacement]);
  let joinedEarly=false;const heldJoins=Promise.all([timed.slot.join(),aborted.slot.join()]).then(()=>{joinedEarly=true;});
  for(const j of [timed,aborted])release(j,false);await until(()=>[timed,aborted].every(j=>results.includes(j.id)));await pause();assert.equal(joinedEarly,false);assert.equal(ownedWorkerUsage().Background,3);
  for(const j of [timed,aborted]){assert.equal(j.settlements,1);assert.equal(exits.includes(j.id),false);release(j);await j.slot.join();assert.equal(Atomics.load(new Int32Array(j.shared),2),1);assert.ok(results.includes(j.id));assert.ok(exits.includes(j.id));assert.equal(j.settlements,1);}
  await heldJoins;
  for(const j of held.filter(j=>!released.has(j.id)&&j!==timed&&j!==aborted))await success(j);
  assert.deepEqual(ownedWorkerUsage(),zero);
  const fresh:Job[]=[];for(const lane of lanes){const j=submit(`fresh-${lane}`,lane,15000);fresh.push(j);await success(j);}
  await Promise.all(jobs.map(j=>j.slot.join()));assert.deepEqual(ownedWorkerUsage(),zero);unconstructed([...removed,...refused]);
  const expected=[...held,...live,...fresh].map(j=>j.id).sort();assert.deepEqual(constructors.filter(id=>id!=='probe').sort(),expected);assert.deepEqual(exits.filter(id=>id!=='probe').sort(),expected);assert.deepEqual(results.sort(),expected);assert.ok([...held,...live,...fresh].every(started));assert.ok(jobs.every(j=>j.settlements===1&&!j.slot.busy));
  assert.equal(expected.length,19);assert.equal(refused.length,12);assert.equal(jobs.length,289);assert.equal(constructors.filter(id=>id==='probe').length,1);assert.ok(samples.length>0&&samples.length<=2400);assert.equal(constructors.length,20);assert.equal(results.length,19);
  assert.ok(samples.length>0);for(let i=0;i<samples.length;i++)assert.equal(samples[i]!.sequence,i+1);
  const late=samples.map(s=>Math.max(0,s.received-s.target)).sort((a,b)=>a-b);
  summary={checkpoint:937,qualified:false,ownerAcceptance:true,nativeConstructed:expected.length,nativeStarted:expected.length,nativeExited:expected.length,initialHeld:8,queueOffered:258,queueExpired:3,queueCancelled:255,refusedWithoutConstruction:refused.length,liveFifo:6,freshAfterJoin:5,offeredBytesPerSubmission:64,totalOfferedFixtureBytes:jobs.length*64,submissions:jobs.length,probeIntervalMs:25,probeSamples:samples.length,probeP95LatenessMs:late[Math.floor((late.length-1)*0.95)],probeMaxLatenessMs:late.at(-1),probeMaxSendDriftMs:Math.max(...samples.map(s=>Math.max(0,s.sent-s.target))),probeMaxDeliveryDelayMs:Math.max(...samples.map(s=>Math.max(0,s.received-s.sent))),finalUsage:ownedWorkerUsage()};
 }finally{
  for(const j of jobs){j.controller.abort('synthetic-cleanup');release(j);}await Promise.allSettled(jobs.map(j=>j.pending));await Promise.all(jobs.map(j=>j.slot.join()));probe.postMessage('stop');await probeJoined;builtin.Worker=OriginalWorker;syncBuiltinESMExports();
 }
 assert.ok(summary);assert.deepEqual(ownedWorkerUsage(),zero);assert.equal(exits.filter(x=>x==='probe').length,1);
 const output=process.env.NATIVE_MIXED_LANE_OUTPUT;if(!output)throw new Error('Explicit private summary output required');writeFileSync(output,JSON.stringify(summary,null,2)+'\n');
});
