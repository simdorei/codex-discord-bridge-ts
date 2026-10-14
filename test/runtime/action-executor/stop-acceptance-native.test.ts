import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {getIngressIn} from '../../../src/store/ingress-read.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {parseStopControlJson} from '../../../src/store/stop-control-dispatch.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {NativeBridgeStateOwner} from '../../../src/runtime/bridge-state-native.ts';
import {NativeStopAcceptanceWriter,NativeStopAcceptanceUnknownError} from '../../../src/runtime/action-executor/stop-acceptance-native.ts';
import {captureStopAcceptance,stopAcceptanceBinding,assertStopAcceptanceRequestBudget,type StopAcceptanceInput} from '../../../src/runtime/action-executor/stop-acceptance-snapshot.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const scope={target:'T',channel:42n,owner:3n},event=9007199254740993n;
async function fixture(run:(f:{path:string;db:DatabaseSync;bridge:NativeBridgeStateOwner;writer:NativeStopAcceptanceWriter;input:StopAcceptanceInput})=>Promise<void>,route:'Explicit'|'Selected'|'Mapped'='Explicit'){
 await storeFixture(async path=>{const db=await openInitialized(path),bridgePath=join(dirname(path),'bridge.json');new BridgeState(bridgePath).setSelectedThreadId('T');const bridge=new NativeBridgeStateOwner(bridgePath),writer=new NativeStopAcceptanceWriter(path,bridge),binding={target:'T',route,command:{Stop:{reference:route==='Explicit'?'T':null}}};
 try{db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,source_message_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES (?,'message',?,42,3,?,?,'executing','processing','T',1,1)").run(`message:${event}`,event,event,serializeSerdeValue({version:1n,lifecycle_binding:binding,plan:{Execute:binding.command}}));
 await run({path,db,bridge,writer,input:{scope,binding,ingress:getIngressIn(db,`message:${event}`)!,resident:{id:'resident',generation:9n},now:10}});
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}});
}
function job(db:DatabaseSync,state='running',generation=9n,id='j'){db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES(?,'T',42,3,?,'original',0,1,?,1,?,'[]',1,1)").run(id,generation,state,state==='running'?'turn':null);}
function count(db:DatabaseSync,table:string){return db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n;}
function unknown(e:unknown):boolean{return e instanceof NativeStopAcceptanceUnknownError&&e.operationId===`stop:message:${event}`&&e.ingressKey===`message:${event}`&&e.eventId===event;}

test('native Running acceptance preserves original queue, exact big identities and generation mismatch can_settle=false',async()=>{
 for(const generation of [9n,8n])await fixture(async f=>{job(f.db,'running',generation);const before=f.db.prepare('SELECT * FROM codex_turn_queue').all();assert.deepEqual(await f.writer.execute(f.input),{kind:'Running',operationId:`stop:message:${event}`});assert.deepEqual(f.db.prepare('SELECT * FROM codex_turn_queue').all(),before);const raw=f.db.prepare('SELECT record_json FROM cdr_stop_controls').get()!.record_json as string,control=parseStopControlJson(raw);assert.equal(control.can_settle,generation===9n);assert.equal(control.generation,9n);assert.equal(control.turn,'turn');assert.equal(getIngressIn(f.db,f.input.ingress.ingressId)!.phase,'stop_accepted');assert.equal(count(f.db,'cdr_execution_holds'),1);assert.equal(count(f.db,'cdr_stop_revision_receipts'),1);assert.equal(ownedWorkerUsage().Control,0);});
});
test('confirmed no-Running read alone reaches Unresolved in same submission without interrupt',()=>fixture(async f=>{job(f.db,'pending');assert.deepEqual(await f.writer.execute(f.input),{kind:'Unresolved',operationId:`stop:message:${event}`,jobs:1,ingresses:0});assert.equal(count(f.db,'cdr_stop_controls'),0);assert.equal(count(f.db,'cdr_execution_holds'),1);assert.equal(count(f.db,'cdr_stop_revision_receipts'),1);}));
test('actor event ingress mapping and final trigger custody failures retain original processing ingress and roll back',async()=>{
 for(const sql of ["UPDATE codex_turn_queue SET owner_user_id=4","UPDATE discord_ingress_journal SET source_message_id=7","UPDATE discord_ingress_journal SET payload_json='{}'","CREATE TRIGGER bad AFTER INSERT ON cdr_stop_revisions BEGIN UPDATE codex_turn_queue SET turn_id='changed'; END"])
 await fixture(async f=>{job(f.db);f.db.exec(sql);await assert.rejects(f.writer.execute(f.input),unknown);assert.equal(count(f.db,'cdr_execution_holds'),0);assert.equal(count(f.db,'cdr_stop_revision_receipts'),0);assert.equal(getIngressIn(f.db,f.input.ingress.ingressId)!.phase,'processing');});
 await fixture(async f=>{job(f.db);await assert.rejects(f.writer.execute(f.input),unknown);assert.equal(count(f.db,'cdr_stop_revision_receipts'),0);},'Mapped');
});
test('missing and partial databases never create migrate or report acceptance',()=>fixture(async f=>{
 const missing=f.path+'.missing';await assert.rejects(new NativeStopAcceptanceWriter(missing,f.bridge).execute(f.input),unknown);assert.equal(existsSync(missing),false);
 const partial=f.path+'.partial',db=new DatabaseSync(partial);db.exec('CREATE TABLE sentinel(value TEXT)');db.close();const before=readFileSync(partial);await assert.rejects(new NativeStopAcceptanceWriter(partial,f.bridge).execute(f.input),unknown);assert.deepEqual(readFileSync(partial),before);
}));
test('preabort and invalid hooked oversized transport refuse before any native submission',async t=>fixture(async f=>{
 let calls=0;t.mock.method(OwnedWorkerSlot.prototype,'run',()=>{calls++;throw new Error('not submitted');});const c=new AbortController(),reason=new Error('abort');c.abort(reason);await assert.rejects(f.writer.execute(f.input,c.signal),e=>e===reason);
 const hooked=new AbortController().signal;Object.defineProperty(hooked,'throwIfAborted',{value(){calls++;}});await assert.rejects(f.writer.execute(f.input,hooked));
 const getter=Object.defineProperty({...f.input},'ingress',{get(){calls++;return f.input.ingress;},enumerable:true});await assert.rejects(f.writer.execute(getter));
 await assert.rejects(f.writer.execute({...f.input,ingress:{...f.input.ingress,payload:'x'.repeat(262144)}}));assert.equal(calls,0);assert.equal(count(f.db,'cdr_stop_revision_receipts'),0);
}));
test('capture freezes exact original request before selected-read await',async t=>fixture(async f=>{
 const mutable=structuredClone(f.input),run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).includes('bridge-state-native-worker')){(mutable.scope as {target:string}).target='foreign';mutable.ingress.ownerUserId=77n;}return run.apply(this,args);});
 assert.equal((await f.writer.execute(mutable)).kind,'Unresolved');assert.equal(getIngressIn(f.db,f.input.ingress.ingressId)!.ownerUserId,3n);assert.ok(Object.isFrozen(captureStopAcceptance(f.input).ingress));
},'Selected'));
test('real SQLite lock waits leave event loop live; same owner and global capacity refuse without queued second write',()=>fixture(async f=>{
 job(f.db);f.db.exec('BEGIN IMMEDIATE');let ticks=0;const timer=setInterval(()=>ticks++,5),pending=f.writer.execute(f.input);assert.equal(ownedWorkerUsage().Control,1);
 await assert.rejects(f.writer.execute(f.input),OwnedWorkerBusyError);await assert.rejects(new NativeStopAcceptanceWriter(f.path,f.bridge).execute(f.input),OwnedWorkerBusyError);
 setTimeout(()=>f.db.exec('ROLLBACK'),120);try{assert.equal((await pending).kind,'Running');}finally{clearInterval(timer);}assert.ok(ticks>=3);assert.equal(count(f.db,'cdr_stop_revision_receipts'),1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('postsubmit abort and deadline join actual native exit, retain original operation, never submit fallback or retry',async t=>{
 for(const mode of ['abort','deadline'] as const)await fixture(async f=>{
  job(f.db);f.db.exec('BEGIN IMMEDIATE');const c=new AbortController(),run=OwnedWorkerSlot.prototype.run;let calls=0;const mock=t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).includes('stop-acceptance-native-worker'))calls++;return run.apply(this,args);});
  const started=Date.now(),pending=f.writer.execute(f.input,c.signal,mode==='deadline'?1:6000);let settled=false;const observed=assert.rejects(pending,unknown).then(()=>{settled=true;});if(mode==='abort')c.abort(new Error('cancel after submit'));
  await new Promise(r=>setTimeout(r,50));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);f.db.exec('ROLLBACK');await observed;mock.mock.restore();assert.ok(Date.now()-started>=50);assert.equal(calls,1);assert.equal(ownedWorkerUsage().Control,0);assert.equal(count(f.db,'cdr_stop_revision_receipts'),1);
 });
});
test('lost acknowledgement after real commit is Unknown with one submission and no second durable write',async t=>fixture(async f=>{
 job(f.db);const run=OwnedWorkerSlot.prototype.run;let calls=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){calls++;return run.apply(this,args).then(()=>{throw new Error('lost acknowledgement');});});await assert.rejects(f.writer.execute(f.input),unknown);assert.equal(calls,1);assert.equal(count(f.db,'cdr_stop_revision_receipts'),1);assert.equal(count(f.db,'cdr_stop_controls'),1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('Selected lease survives actual Control release until parent validates, blocks all same-owner operations then releases',async t=>fixture(async f=>{
 const run=OwnedWorkerSlot.prototype.run;let sawExit=false;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(!String(args[0]).includes('stop-acceptance-native-worker'))return pending;return pending.then(async value=>{sawExit=true;assert.equal(ownedWorkerUsage().Control,0);for(const operation of [{kind:'Selected'},{kind:'Select',id:'T'},{kind:'Remember',id:'T',model:null,reasoning:null,speed:null},{kind:'Fork',source:'T',target:'U'},{kind:'ClearScope',scope:['T']}] as const)await assert.rejects(f.bridge.execute(operation),OwnedWorkerBusyError);return value;});});
 assert.equal((await f.writer.execute(f.input)).kind,'Unresolved');assert.equal(sawExit,true);assert.equal(await f.bridge.execute({kind:'Selected'}),'T');
},'Selected'));

test('native Running and Unresolved preserve SQLite REAL infinities in original queue and ingress custody',async()=>{for(const state of ['running','pending'])await fixture(async f=>{job(f.db,state);f.db.prepare('UPDATE codex_turn_queue SET created_at=?,updated_at=?').run(Infinity,-Infinity);f.db.prepare('UPDATE discord_ingress_journal SET created_at=?,updated_at=?').run(Infinity,-Infinity);const input={...f.input,ingress:getIngressIn(f.db,f.input.ingress.ingressId)!};assert.equal((await f.writer.execute(input)).kind,state==='running'?'Running':'Unresolved');assert.equal(getIngressIn(f.db,input.ingress.ingressId)!.createdAt,Infinity);assert.equal(f.db.prepare('SELECT created_at FROM codex_turn_queue').get()!.created_at,Infinity);});});
test('signal mutation across selected-read await is revalidated before lease and native submission',async t=>fixture(async f=>{
 const c=new AbortController(),run=OwnedWorkerSlot.prototype.run;let calls=0,hookCalls=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).includes('bridge-state-native-worker')&&!Object.hasOwn(c.signal,'addEventListener'))Object.defineProperty(c.signal,'addEventListener',{value(){hookCalls++;throw new Error('hook');}});else calls++;return task;});
 await assert.rejects(f.writer.execute(f.input,c.signal),/unmodified native AbortSignal/);assert.equal(calls,0);assert.equal(hookCalls,0);assert.equal(ownedWorkerUsage().Control,0);assert.equal(count(f.db,'cdr_stop_revision_receipts'),0);assert.equal(await f.bridge.execute({kind:'Selected'}),'T');
},'Selected'));
test('caller signal hooks replaced after submission cannot strand actual exit or selected lease cleanup',async t=>fixture(async f=>{
 const c=new AbortController(),run=OwnedWorkerSlot.prototype.run;let hookCalls=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).includes('stop-acceptance-native-worker'))for(const name of ['removeEventListener','throwIfAborted'])Object.defineProperty(c.signal,name,{value(){hookCalls++;throw new Error('caller hook');}});return task;});
 await assert.rejects(f.writer.execute(f.input,c.signal),unknown);assert.equal(hookCalls,0);assert.equal(ownedWorkerUsage().Control,0);assert.equal(await f.bridge.execute({kind:'Selected'}),'T');assert.equal(count(f.db,'cdr_stop_revision_receipts'),1);
},'Selected'));
test('crossed and oversized scalar acknowledgement stays Unknown after real exit and one write',async t=>{for(const bad of ['id','path','operationId','eventId','target','count','oversized'])await fixture(async f=>{
 const run=OwnedWorkerSlot.prototype.run,mock=t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){return run.apply(this,args).then((value:any)=>bad==='count'?{...value,value:{...value.value,jobs:129}}:bad==='oversized'?{...value,extra:'x'.repeat(65536)}:{...value,[bad]:'crossed'});});try{await assert.rejects(f.writer.execute(f.input),unknown);assert.equal(count(f.db,'cdr_stop_revision_receipts'),1);assert.equal(ownedWorkerUsage().Control,0);}finally{mock.mock.restore();}
});});
test('selected proof liveness loss while waiting on SQLite refuses commit and still releases owner after actual exit',async t=>fixture(async f=>{
 job(f.db);const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).includes('stop-acceptance-native-worker')){const q=args[1] as any;Atomics.store(new Int32Array(q.proof.active),0,0);}return run.apply(this,args);});await assert.rejects(f.writer.execute(f.input),unknown);assert.equal(count(f.db,'cdr_stop_revision_receipts'),0);assert.equal(count(f.db,'cdr_execution_holds'),0);assert.equal(ownedWorkerUsage().Control,0);assert.equal(await f.bridge.execute({kind:'Selected'}),'T');
},'Selected'));

test('full request envelope budget includes duplicated identities and proof metadata before acquisition',()=>fixture(async f=>{const operation=captureStopAcceptance({...f.input,ingress:{...f.input.ingress,payload:'x'.repeat(240000)}});assert.throws(()=>assertStopAcceptanceRequestBudget(stopAcceptanceBinding('request','/'.repeat(32768),operation),operation),/envelope.*transport/);assert.doesNotThrow(()=>assertStopAcceptanceRequestBudget(stopAcceptanceBinding('request',f.path,captureStopAcceptance(f.input)),captureStopAcceptance(f.input)));}));
test('earlier stopImmediatePropagation abort listener cannot hide source cancellation after actual Stop submission',async t=>fixture(async f=>{
 const c=new AbortController();c.signal.addEventListener('abort',event=>event.stopImmediatePropagation());const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).includes('stop-acceptance-native-worker'))c.abort(new Error('suppressed source abort'));return task;});
 await assert.rejects(f.writer.execute(f.input,c.signal),unknown);assert.equal(ownedWorkerUsage().Control,0);assert.equal(count(f.db,'cdr_stop_revision_receipts'),1);
}));
test('suppressed source abort during Selected capture still refuses before Stop lease and submission',async t=>fixture(async f=>{
 const c=new AbortController(),reason=new Error('suppressed capture abort');c.signal.addEventListener('abort',event=>event.stopImmediatePropagation());const run=OwnedWorkerSlot.prototype.run;let stopCalls=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).includes('bridge-state-native-worker'))c.abort(reason);else stopCalls++;return task;});
 await assert.rejects(f.writer.execute(f.input,c.signal),e=>e===reason);assert.equal(stopCalls,0);assert.equal(ownedWorkerUsage().Control,0);assert.equal(count(f.db,'cdr_stop_revision_receipts'),0);assert.equal(await f.bridge.execute({kind:'Selected'}),'T');
},'Selected'));
test('native Stop revision advance retains exact bigint clock above Number safe integer',()=>fixture(async f=>{
 const revision=9007199254740993n;f.db.prepare('UPDATE cdr_stop_clock SET revision=?').run(revision);f.db.prepare("INSERT INTO cdr_stop_revision_receipts VALUES('prior','other',?,'{}')").run(revision);f.db.prepare("INSERT INTO cdr_stop_revisions VALUES('other',?,'prior')").run(revision);
 assert.equal((await f.writer.execute(f.input)).kind,'Unresolved');const q=f.db.prepare('SELECT revision FROM cdr_stop_clock');q.setReadBigInts(true);assert.equal(q.get()!.revision,revision+1n);assert.equal(count(f.db,'cdr_stop_revision_receipts'),2);
}));
test('Selected lease remains held across postsubmit abort and deadline until blocked SQLite worker actually exits',async t=>{for(const mode of ['abort','deadline'])await fixture(async f=>{
 job(f.db);f.db.exec('BEGIN IMMEDIATE');const c=new AbortController(),run=OwnedWorkerSlot.prototype.run;let submitted!:()=>void;const admission=new Promise<void>(r=>{submitted=r;});const mock=t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).includes('stop-acceptance-native-worker'))submitted();return task;});
 const pending=f.writer.execute(f.input,c.signal,mode==='deadline'?1:6000);let settled=false;const observed=assert.rejects(pending,unknown).then(()=>{settled=true;});await admission;if(mode==='abort')c.abort(new Error('selected abort'));await new Promise(r=>setTimeout(r,50));assert.equal(settled,false);await assert.rejects(f.bridge.execute({kind:'Selected'}),OwnedWorkerBusyError);assert.equal(ownedWorkerUsage().Control,1);f.db.exec('ROLLBACK');await observed;mock.mock.restore();assert.equal(ownedWorkerUsage().Control,0);assert.equal(await f.bridge.execute({kind:'Selected'}),'T');assert.equal(count(f.db,'cdr_stop_revision_receipts'),1);
},'Selected');});
test('Selected lease releases on zero-queue refusal when another Control operation wins after selected read',async t=>fixture(async f=>{
 const run=OwnedWorkerSlot.prototype.run,blocker=new OwnedWorkerSlot('Control');let other:Promise<unknown>|undefined;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).includes('bridge-state-native-worker')&&other===undefined)return task.then(value=>{other=run.call(blocker,args[0],args[1],6000);return value;});return task;});
 await assert.rejects(f.writer.execute(f.input),OwnedWorkerBusyError);await other;await blocker.join();assert.equal(count(f.db,'cdr_stop_revision_receipts'),0);assert.equal(ownedWorkerUsage().Control,0);assert.equal(await f.bridge.execute({kind:'Selected'}),'T');
},'Selected'));
