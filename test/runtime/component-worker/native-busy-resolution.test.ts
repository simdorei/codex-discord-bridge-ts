import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as sleep} from 'node:timers/promises';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {NativeBusyClaimOwner,NativeBusyClaimUnknownError,type NativeBusyClaim} from '../../../src/runtime/component-worker/busy-claim-native.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createBusyChoice,getBusyChoice} from '../../../src/store/busy-choice-store.ts';
import {resolveBusyControlExisting} from '../../../src/store/control-binding.ts';
import {serializeBusyChoice,type BusyChoice} from '../../../src/store/busy-choice.ts';
import {parseComponentId,type BusyAction} from '../../../src/discord/components.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {work} from '../../helpers/interaction-worker-fixture.ts';
const component=(c:BusyChoice,action:BusyAction='Stop')=>parseComponentId(`codex_busy:${c.choiceId}:${action.toLowerCase()}`)!;
const click=(path:string,c:BusyChoice,id=3n,action:BusyAction='Stop')=>({...work(path,id,new AdmissionGate(),`codex_busy:${c.choiceId}:${action.toLowerCase()}`),authorizedBusyChoice:c});
async function choice(path:string){const id=await createBusyChoice(path,{ownerUserId:2n,channelId:1n,targetThreadId:'t',prompt:'original 😀',allowSteer:false,now:1,timeToLive:100});return (await getBusyChoice(path,id,2))!;}
function edit(path:string,sql:string){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
function row(path:string,c:BusyChoice){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT turn_id,job_id,thread_id FROM codex_busy_control_bindings WHERE choice_id=?').get(c.choiceId);}finally{db.close();}}
async function held(owner:NativeBusyClaimOwner,path:string,c:BusyChoice,action:BusyAction='Stop'):Promise<NativeBusyClaim>{const w=click(path,c,3n,action);try{const result=await owner.claim(w,component(c,action),2);if(result.kind!=='ExecuteAction')throw Error('claim fixture');return result.claim;}finally{w.admissionPermit!.release();}}
async function job(path:string,turn='first'){await state.enqueue(path,queueJob({jobId:'job',targetThreadId:'t'}));edit(path,`UPDATE codex_turn_queue SET state='running',turn_id='${turn}'`);}
const isResolve=(args:Parameters<OwnedWorkerSlot['run']>)=>String(args[0]).endsWith('/busy-claim-native-worker.ts')&&(args[1] as any).operation==='Resolve';

for(const action of ['Stop','Steer'] as const)for(const finish of ['Ready','Release'] as const)test(`${action} resolves its original explicit turn once and keeps owned ${finish} completion`,async t=>storeFixture(async path=>{
 const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t','first','original-job');const owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c,action),ops:any[]=[],run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isResolve(args))ops.push(args[1]);return run.apply(this,args);});
 try{assert.equal(await owner.resolve(h,c,action),'first');assert.throws(()=>owner.resolve(h,c,action),TypeError);assert.equal(ops.length,1);assert.equal(ops[0].choiceJson,serializeBusyChoice(c));assert.equal(ops[0].interactionIngressId,'interaction:3');assert.equal(ops[0].interactionId,3n);assert.equal(ops[0].applicationId,4n);assert.equal(ops[0].sourceMessageId,9n);assert.equal(ops[0].action,action);
  if(finish==='Ready')await owner.ready(h,3);else await owner.release(h);assert.throws(()=>owner.resolve(h,c,action),TypeError);assert.equal((await state.readBusyChoiceState(path,c.choiceId,3))!.claimed,finish==='Ready');
 }finally{await owner.close();}
}));

test('late binding pins only the exact preceding running job and never follows a later job turn',async()=>storeFixture(async path=>{
 await job(path);const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t',null,'job');const owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c);
 try{assert.equal(row(path,c)!.turn_id,null);assert.equal(await owner.resolve(h,c,'Stop'),'first');assert.equal(row(path,c)!.turn_id,'first');edit(path,"UPDATE codex_turn_queue SET turn_id='later',state='completed',goal_waiting=1");assert.equal(resolveBusyControlExisting(path,c.choiceId,'t'),'first');await owner.ready(h,3);}finally{await owner.close();}
}));

for(const mode of ['missing_binding','foreign_binding','missing_job','foreign_job','starting','completed','waiting','null_turn','no_job'] as const)test(`${mode} resolution is null without discovery or binding another turn`,async()=>storeFixture(async path=>{
 await job(path);const c=await choice(path);if(mode!=='missing_binding')await state.bindBusyControl(path,c.choiceId,mode==='foreign_binding'?'other':'t',null,mode==='missing_job'?'absent':mode==='no_job'?null:'job');
 if(mode==='foreign_job')edit(path,"UPDATE codex_turn_queue SET target_thread_id='other'");if(mode==='starting'||mode==='completed')edit(path,`UPDATE codex_turn_queue SET state='${mode}'`);if(mode==='waiting')edit(path,'UPDATE codex_turn_queue SET goal_waiting=1');if(mode==='null_turn')edit(path,'UPDATE codex_turn_queue SET turn_id=NULL');
 const owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c);try{assert.equal(await owner.resolve(h,c,'Stop'),null);assert.equal(row(path,c)?.turn_id??null,null);await owner.release(h);assert.equal((await state.readBusyChoiceState(path,c.choiceId,3))!.claimed,false);}finally{await owner.close();}
}));

test('preparing binding trigger keeps its first turn even after job starts a later goal',async()=>storeFixture(async path=>{
 await state.enqueue(path,queueJob({jobId:'job',targetThreadId:'t'}));const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t',null,'job');edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='first';UPDATE codex_turn_queue SET goal_waiting=1,turn_id='later'");const owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c);try{assert.equal(await owner.resolve(h,c,'Stop'),'first');}finally{await owner.close();}
}));

for(const turn of ['',"turn'😀"])test(`exact explicit ${turn===''?'empty':'Unicode'} turn is preserved`,async()=>storeFixture(async path=>{const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t',turn,null);const owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c);try{assert.equal(await owner.resolve(h,c,'Stop'),turn);}finally{await owner.close();}}));

test('copied, cross-owner, wrong actor/channel/target/choice/prompt/action and consumed handles cannot authorize resolution',async t=>storeFixture(async path=>{
 const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t','first',null);const a=new NativeBusyClaimOwner(path),b=new NativeBusyClaimOwner(path),h=await held(a,path,c);let count=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(isResolve(args))count++;return run.apply(this,args);});
 try{for(const fake of [{...h},{},Object.create(Object.getPrototypeOf(h))])assert.throws(()=>a.resolve(fake,c,'Stop'),TypeError);assert.throws(()=>b.resolve(h,c,'Stop'),TypeError);
  for(const patch of [{ownerUserId:7n},{channelId:7n},{targetThreadId:'other'},{choiceId:'b'.repeat(24)},{prompt:'other'},{allowSteer:true},{expiresAt:200}])assert.throws(()=>a.resolve(h,{...c,...patch},'Stop'),TypeError);
  for(const action of ['Steer','Queue','Ignore'] as const)assert.throws(()=>a.resolve(h,c,action),TypeError);assert.equal(count,0);assert.equal(await a.resolve(h,c,'Stop'),'first');assert.equal(count,1);await a.release(h);assert.throws(()=>a.resolve(h,c,'Stop'),TypeError);
 }finally{await a.close();await b.close();}
}));

for(const action of ['Ignore','Queue'] as const)test(`${action} cannot mint control resolution authority`,async()=>storeFixture(async path=>{
 const c=await choice(path),a=new NativeBusyClaimOwner(path),w=click(path,c,3n,action);try{const result=await a.claim(w,component(c,action),2);if(result.kind==='ExecuteAction')for(const op of [action,'Stop','Steer'] as const)assert.throws(()=>a.resolve(result.claim,c,op),TypeError);else assert.equal(result.kind,'ExecuteQueue');}finally{w.admissionPermit!.release();await a.close();}
}));

for(const failure of ['rollback','lost_ack','partial_ack','bad_value'] as const)test(`${failure} resolution retains claim, blocks fresh actions and only permits same-original ready recovery`,async t=>storeFixture(async path=>{
 await job(path);const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t',null,'job');const owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c),next=await choice(path),other=click(path,next,4n),original=click(path,c,5n);let count=0;const run=OwnedWorkerSlot.prototype.run;
 if(failure==='rollback')edit(path,"CREATE TRIGGER refuse_resolution BEFORE UPDATE ON codex_busy_control_bindings BEGIN SELECT RAISE(ABORT,'fixture'); END");
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(!isResolve(args))return task;count++;return task.then(raw=>{if(failure==='lost_ack')throw Error('lost Resolve ACK');return failure==='partial_ack'?{ok:true,value:'first'}:failure==='bad_value'?{...raw as any,value:{turn:'first'}}:raw;});});
 try{await assert.rejects(owner.resolve(h,c,'Stop'),e=>e instanceof NativeBusyClaimUnknownError&&e.operation==='Resolve');assert.equal(row(path,c)!.turn_id,failure==='rollback'?null:'first');assert.equal((await state.readBusyChoiceState(path,c.choiceId,3))!.claimed,true);assert.throws(()=>owner.resolve(h,c,'Stop'),TypeError);assert.throws(()=>owner.ready(h,3),TypeError);assert.throws(()=>owner.release(h),TypeError);
  await assert.rejects(owner.claim(other,component(next),10000),NativeBusyClaimUnknownError);assert.deepEqual(await owner.claim(original,component(c),10000),{kind:'ActionUnconfirmed'});assert.equal(count,1);
 }finally{original.admissionPermit!.release();other.admissionPermit!.release();await owner.close();}
}));

for(const key of ['id','path','operation','interactionIngressId','interactionId','applicationId','actorId','channelId','sourceMessageId','customId','choiceJson','choiceId','action','readyMarker','now','expiresAt'] as const)test(`crossed Resolve ${key} ACK cannot release or refresh the original capability`,async t=>storeFixture(async path=>{
 const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t','first',null);const owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c),run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);return isResolve(args)?task.then(raw=>({...raw as any,[key]:typeof (raw as any)[key]==='bigint'?99n:'crossed'})):task;});
 try{await assert.rejects(owner.resolve(h,c,'Stop'),NativeBusyClaimUnknownError);assert.throws(()=>owner.release(h),TypeError);assert.equal((await state.readBusyChoiceState(path,c.choiceId,3))!.claimed,true);}finally{await owner.close();}
}));

for(const trigger of ["SELECT RAISE(IGNORE)","UPDATE codex_busy_control_bindings SET job_id='other' WHERE choice_id=NEW.choice_id",'DELETE FROM codex_busy_control_bindings WHERE choice_id=NEW.choice_id',"UPDATE codex_busy_control_bindings SET thread_id='other' WHERE choice_id=NEW.choice_id", "UPDATE codex_busy_control_bindings SET turn_id='wrong' WHERE choice_id=NEW.choice_id"])test(`resolution exact readback rolls back ${trigger.split(' ')[0]} trigger drift`,async()=>storeFixture(async path=>{
 await job(path);const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t',null,'job');edit(path,`CREATE TRIGGER drift_resolution ${trigger.startsWith('SELECT')?'BEFORE':'AFTER'} UPDATE OF turn_id ON codex_busy_control_bindings BEGIN ${trigger}; END`);const owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c);
 try{await assert.rejects(owner.resolve(h,c,'Stop'),NativeBusyClaimUnknownError);assert.deepEqual({...row(path,c)},{turn_id:null,job_id:'job',thread_id:'t'});}finally{await owner.close();}
}));

for(const empty of [false,true])test(`resolution never ${empty?'initializes an empty catalog':'creates a missing database'}`,async()=>storeFixture(async path=>{
 const c=await choice(path),owner=new NativeBusyClaimOwner(path),h=await held(owner,path,c);rmSync(path);if(empty)new DatabaseSync(path).close();try{await assert.rejects(owner.resolve(h,c,'Stop'),NativeBusyClaimUnknownError);assert.equal(existsSync(path),empty);if(empty){const db=new DatabaseSync(path);try{assert.deepEqual(db.prepare('SELECT name FROM sqlite_master').all(),[]);}finally{db.close();}}}finally{await owner.close();}
}));

for(const mode of ['deadline','cancel','close'] as const)test(`${mode} during resolution retains Control ownership and completion capability until actual exit`,async t=>storeFixture(async path=>{
 await job(path);const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t',null,'job');const a=new NativeBusyClaimOwner(path),h=await held(a,path,c),cancel=new AbortController(),run=OwnedWorkerSlot.prototype.run;if(mode==='deadline')t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){return isResolve(args)?run.call(this,args[0],args[1],30,args[3]):run.apply(this,args);});
 const db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');let finished=false,closed=false,ticks=0;const timer=setInterval(()=>ticks++,5),pending=a.resolve(h,c,'Stop',cancel.signal),failed=assert.rejects(pending,NativeBusyClaimUnknownError);void pending.then(()=>finished=true,()=>finished=true);let closing:Promise<void>|undefined;
 try{await sleep(100);if(mode==='cancel')cancel.abort(Error('cancel'));if(mode==='close')closing=a.close().then(()=>{closed=true;});await sleep(70);assert.equal(finished,false);assert.equal(closed,false);assert.equal(a.busy,true);assert.equal(ownedWorkerUsage().Control,1);assert.ok(ticks>3);assert.throws(()=>a.ready(h,3),TypeError);assert.throws(()=>a.release(h),TypeError);assert.throws(()=>a.resolve(h,c,'Stop'),TypeError);db.exec('ROLLBACK');await failed;await closing;assert.equal(ownedWorkerUsage().Control,0);assert.equal(row(path,c)!.turn_id,'first');assert.throws(()=>a.release(h),TypeError);}finally{clearInterval(timer);if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled([pending,closing]);await a.close();db.close();}
}));

test('same-owner pending and unknown resolution blocks another already-claimed action; proven pre-submit refusal keeps its capability',async t=>storeFixture(async path=>{
 const a=new NativeBusyClaimOwner(path),first=await choice(path),second=await choice(path);await state.bindBusyControl(path,first.choiceId,'t','first',null);await state.bindBusyControl(path,second.choiceId,'t','second',null);const one=await held(a,path,first),two=await held(a,path,second),w=click(path,second,4n),run=OwnedWorkerSlot.prototype.run;let resolveCount=0;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(!isResolve(args))return pending;resolveCount++;return pending.then(()=>{throw Error('lost Resolve ACK');});});const db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const pending=a.resolve(one,first,'Stop'),failed=assert.rejects(pending,NativeBusyClaimUnknownError);
 try{assert.throws(()=>a.resolve(two,second,'Stop'),OwnedWorkerBusyError);await assert.rejects(a.claim(w,component(second),3),OwnedWorkerBusyError);db.exec('ROLLBACK');await failed;assert.throws(()=>a.resolve(two,second,'Stop'),NativeBusyClaimUnknownError);assert.equal(resolveCount,1);assert.equal(row(path,second)!.turn_id,'second');}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});await a.close();db.close();w.admissionPermit!.release();}
}));

test('pre-cancelled and global-capacity-refused resolution leave original capability unused',async()=>storeFixture(async path=>{
 const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t','first',null);const a=new NativeBusyClaimOwner(path),h=await held(a,path,c),cancel=new AbortController();cancel.abort(Error('pre-cancel'));assert.throws(()=>a.resolve(h,c,'Stop',cancel.signal),e=>e===cancel.signal.reason);
 const second=await choice(path),b=new NativeBusyClaimOwner(path),w=click(path,second,4n),db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const pending=b.claim(w,component(second),2);
 try{await assert.rejects(a.resolve(h,c,'Stop'),OwnedWorkerBudgetError);db.exec('ROLLBACK');await pending;assert.equal(await a.resolve(h,c,'Stop'),'first');await a.ready(h,3);}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});await a.close();await b.close();db.close();w.admissionPermit!.release();}
}));

test('oversized resolved turn ACK stays unknown after pinning and never refreshes the claim',async()=>storeFixture(async path=>{
 await job(path);const db=new DatabaseSync(path);try{db.prepare('UPDATE codex_turn_queue SET turn_id=?').run('x'.repeat(524288));}finally{db.close();}const c=await choice(path);await state.bindBusyControl(path,c.choiceId,'t',null,'job');const a=new NativeBusyClaimOwner(path),h=await held(a,path,c);try{await assert.rejects(a.resolve(h,c,'Stop'),NativeBusyClaimUnknownError);assert.equal((row(path,c)!.turn_id as string).length,524288);assert.throws(()=>a.resolve(h,c,'Stop'),TypeError);assert.throws(()=>a.release(h),TypeError);assert.equal((await state.readBusyChoiceState(path,c.choiceId,3))!.claimed,true);}finally{await a.close();}
}));
