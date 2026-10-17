import assert from 'node:assert/strict';
import {it} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {NativeRetractWriter,NativeRetractWriteUnknownError,type RetractWrite} from '../../../src/runtime/action-executor/retract-write-native.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const operation:RetractWrite={ingressKey:'message:9007199254740997',eventId:9007199254740997n,target:'target',channelId:1n,ownerUserId:2n,now:123,requireMirror:false};
async function init(path:string){const db=await openInitialized(path);db.close();}
async function enqueue(path:string,id:string,time:number){await state.enqueue(path,queueJob({jobId:id,ownerUserId:2n,createdAt:time}));}
function inventory(path:string){const db=new DatabaseSync(path);try{return {queue:db.prepare('SELECT job_id FROM codex_turn_queue ORDER BY job_id').all().map(r=>r.job_id),receipts:db.prepare('SELECT job_id FROM codex_request_cancellations ORDER BY job_id').all().map(r=>r.job_id)};}finally{db.close();}}
it('actual native Retract returns the latest cancelled identity after exit and protects replay',()=>storeFixture(async path=>{
 await init(path);await enqueue(path,'older',1);await enqueue(path,'latest',2);const w=new NativeRetractWriter(path);
 assert.equal(await w.execute(operation),'latest');assert.equal(ownedWorkerUsage().Control,0);assert.deepEqual(inventory(path),{queue:['older'],receipts:['latest']});await assert.rejects(enqueue(path,'latest',3),/cancelled/);
 assert.equal(await w.execute({...operation,ingressKey:'message:next',eventId:4n}),'older');assert.equal(await w.execute({...operation,ingressKey:'message:empty',eventId:5n}),null);
}));
it('native Retract cannot create an absent runtime database',()=>storeFixture(async path=>{
 await assert.rejects(new NativeRetractWriter(path).execute(operation),e=>e instanceof NativeRetractWriteUnknownError&&e.ingressKey===operation.ingressKey&&e.eventId===operation.eventId);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);
}));
it('preabort refuses before submission with exact reason and no database',async t=>storeFixture(async path=>{
 const c=new AbortController(),reason=new Error('pre-abort');c.abort(reason);let submitted=0;const original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){submitted++;return original.apply(this,args);});
 await assert.rejects(new NativeRetractWriter(path).execute(operation,c.signal),e=>e===reason);assert.equal(submitted,0);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);
}));
it('invalid and oversized native inputs refuse before admission without accessor hooks',async t=>storeFixture(async path=>{
 const w=new NativeRetractWriter(path);let hooks=0,submitted=0;const original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){submitted++;return original.apply(this,args);});
 for(const input of [{...operation,target:'a'.repeat(16385)},{...operation,ingressKey:'a'.repeat(16385)},{...operation,target:'😀'.repeat(4097)},{...operation,target:'\ud800'},{...operation,eventId:1n<<63n},{...operation,ownerUserId:-1n},{...operation,now:NaN},{...operation,extra:true},new Proxy(operation,{get(){hooks++;throw Error('getter');}})])await assert.rejects(w.execute(input as RetractWrite));
 await assert.rejects(w.execute(operation,undefined,0));assert.equal(hooks,0);assert.equal(submitted,0);assert.equal(existsSync(path),false);
}));
it('native owner binds the exact database and refuses borrowed instances',()=>storeFixture(async path=>{
 const w=new NativeRetractWriter(path);w.assertPath(path);assert.throws(()=>w.assertPath(path+'.other'),/another database/);assert.throws(()=>NativeRetractWriter.prototype.assertPath.call(Object.create(NativeRetractWriter.prototype),path),TypeError);
}));
it('SQLite lock wait does not block event-loop control and releases capacity only after exit',()=>storeFixture(async path=>{
 await init(path);await enqueue(path,'job',1);const lock=new DatabaseSync(path);let ticks=0;const timer=setInterval(()=>ticks++,2);
 try{lock.exec('BEGIN IMMEDIATE');await assert.rejects(new NativeRetractWriter(path).execute(operation),NativeRetractWriteUnknownError);assert.ok(ticks>2);assert.equal(lock.isTransaction,true);assert.equal(ownedWorkerUsage().Control,0);}finally{clearInterval(timer);if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}
 assert.deepEqual(inventory(path),{queue:['job'],receipts:[]});assert.equal(await new NativeRetractWriter(path).execute({...operation,ingressKey:'message:recovered',eventId:6n}),'job');
}));
it('same-owner overlap and global Control saturation refuse without another cancellation',()=>storeFixture(async path=>{
 await init(path);await enqueue(path,'older',1);await enqueue(path,'latest',2);const w=new NativeRetractWriter(path),pending=w.execute(operation);assert.equal(ownedWorkerUsage().Control,1);
 await assert.rejects(w.execute({...operation,ingressKey:'overlap'}),e=>e instanceof OwnedWorkerBusyError&&!(e instanceof NativeRetractWriteUnknownError));
 await assert.rejects(new NativeRetractWriter(path).execute({...operation,ingressKey:'saturated'}),OwnedWorkerBudgetError);assert.equal(ownedWorkerUsage().Control,1);assert.equal(await pending,'latest');assert.deepEqual(inventory(path),{queue:['older'],receipts:['latest']});
}));
it('submitted abort joins native exit, preserves original identity and never cancels the next request',()=>storeFixture(async path=>{
 await init(path);await enqueue(path,'older',1);await enqueue(path,'latest',2);const c=new AbortController(),pending=new NativeRetractWriter(path).execute(operation,c.signal);const rejected=assert.rejects(pending,e=>e instanceof NativeRetractWriteUnknownError&&e.ingressKey===operation.ingressKey&&e.eventId===operation.eventId&&e.targetThreadId==='target'&&e.channelId===1n&&e.ownerUserId===2n);
 assert.equal(ownedWorkerUsage().Control,1);c.abort(new Error('post-admission'));assert.equal(ownedWorkerUsage().Control,1);await rejected;assert.equal(ownedWorkerUsage().Control,0);assert.deepEqual(inventory(path),{queue:['older'],receipts:['latest']});
}));
it('submitted deadline joins native exit and cannot turn late committed cancellation into retry',async t=>storeFixture(async path=>{
 await init(path);await enqueue(path,'older',1);await enqueue(path,'latest',2);let submitted=0;const original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){submitted++;return original.apply(this,args);});
 await assert.rejects(new NativeRetractWriter(path).execute(operation,undefined,1),NativeRetractWriteUnknownError);assert.equal(submitted,1);assert.equal(ownedWorkerUsage().Control,0);assert.deepEqual(inventory(path),{queue:['older'],receipts:['latest']});
}));
it('lost reply after actual commit performs one cancel-latest and retains original ingress identity',async t=>storeFixture(async path=>{
 await init(path);await enqueue(path,'older',1);await enqueue(path,'latest',2);let submitted=0;const original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){submitted++;return original.apply(this,args).then(()=>{throw new Error('lost committed reply');});});
 await assert.rejects(new NativeRetractWriter(path).execute(operation),e=>e instanceof NativeRetractWriteUnknownError&&e.ingressKey===operation.ingressKey&&e.eventId===operation.eventId&&/do not retry/.test(e.message));assert.equal(submitted,1);assert.equal(ownedWorkerUsage().Control,0);assert.deepEqual(inventory(path),{queue:['older'],receipts:['latest']});
}));
it('foreign original-ingress acknowledgement is unknown after commit without replay',async t=>storeFixture(async path=>{
 await init(path);await enqueue(path,'older',1);await enqueue(path,'latest',2);const original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){return original.apply(this,args).then((reply:any)=>({...reply,ingressKey:'foreign'}));});
 await assert.rejects(new NativeRetractWriter(path).execute(operation),NativeRetractWriteUnknownError);assert.deepEqual(inventory(path),{queue:['older'],receipts:['latest']});assert.equal(ownedWorkerUsage().Control,0);
}));
it('oversized acknowledgement cannot escape the native return budget',async t=>storeFixture(async path=>{
 await init(path);await enqueue(path,'job',1);const original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){return original.apply(this,args).then((reply:any)=>({...reply,value:'a'.repeat(16385)}));});
 await assert.rejects(new NativeRetractWriter(path).execute(operation),NativeRetractWriteUnknownError);assert.deepEqual(inventory(path),{queue:[],receipts:['job']});
}));
it('caller mutation after submission cannot redirect the captured Retract scope',()=>storeFixture(async path=>{
 await init(path);await enqueue(path,'job',1);const input={...operation},pending=new NativeRetractWriter(path).execute(input);input.target='foreign';input.ingressKey='foreign';input.ownerUserId=9n;assert.equal(await pending,'job');assert.deepEqual(inventory(path),{queue:[],receipts:['job']});
}));
