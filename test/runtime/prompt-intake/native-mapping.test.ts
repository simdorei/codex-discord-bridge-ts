import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {mirroredThreadId,mirroredThreadIdExisting} from '../../../src/store/busy-choice.ts';
import {createNativePromptIntakeState,NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {BusyQueueExecutor} from '../../../src/runtime/action-executor/busy-queue.ts';
function edit<T>(path:string,f:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return f(db);}finally{db.close();}}
async function init(path:string){const db=await openInitialized(path);db.close();}
function mapping(path:string,id:string,parent:bigint,room:bigint){edit(path,db=>db.prepare('INSERT INTO mirror_threads VALUES(?,?,?, ?,?,0)').run(id,'p','title',parent,room));}
test('mapping null and zero avoid DB and native allocation; invalid i64 rejects without coercion',async t=>storeFixture(async path=>{
 let calls=0;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>{calls++;throw new Error('unexpected worker');});const native=createNativePromptIntakeState(path);
 for(const id of [null,0n]){assert.equal(mirroredThreadIdExisting(path,id),null);assert.equal(await native.mirroredThreadId(path,id),null);}
 for(const id of [1,undefined,{},-(1n<<63n)-1n,1n<<63n]){assert.throws(()=>mirroredThreadIdExisting(path,id as bigint),TypeError);await assert.rejects(native.mirroredThreadId(path,id as bigint),TypeError);}
 assert.equal(calls,0);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);
}));
test('existing and native mapping preserve exact priority, unique parent and duplicate exact refusal',async()=>storeFixture(async path=>{
 await init(path);mapping(path,'one',9n,1n);const native=createNativePromptIntakeState(path);
 for(const id of [1n,9n,-1n,(1n<<63n)-1n]){const expected=await mirroredThreadId(path,id);assert.equal(mirroredThreadIdExisting(path,id),expected);assert.equal(await native.mirroredThreadId(path,id),expected);}
 mapping(path,'two',9n,2n);assert.equal(await native.mirroredThreadId(path,9n),null);assert.equal(await native.mirroredThreadId(path,1n),'one');
 mapping(path,'duplicate',8n,1n);assert.throws(()=>mirroredThreadIdExisting(path,1n),/multiple Codex threads/);await assert.rejects(native.mirroredThreadId(path,1n),NativePromptIntakeUnavailableError);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native mapping rejects missing store and incomplete catalog without creating or repairing',async()=>storeFixture(async path=>{
 const native=createNativePromptIntakeState(path);assert.throws(()=>mirroredThreadIdExisting(path,1n));await assert.rejects(native.mirroredThreadId(path,1n),NativePromptIntakeUnavailableError);assert.equal(existsSync(path),false);
 edit(path,db=>db.exec('CREATE TABLE sentinel(value TEXT);INSERT INTO sentinel VALUES(\'keep\')'));
 await assert.rejects(native.mirroredThreadId(path,1n),NativePromptIntakeUnavailableError);assert.deepEqual(edit(path,db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()).map(row=>row.name),['sentinel']);
}));
test('invalid stored UTF8 is unavailable rather than absent or replacement text',async()=>storeFixture(async path=>{
 await init(path);mapping(path,'one',9n,1n);edit(path,db=>db.exec("UPDATE mirror_threads SET codex_thread_id=CAST(x'80' AS TEXT)"));assert.throws(()=>mirroredThreadIdExisting(path,1n),/Invalid text encoding/);await assert.rejects(createNativePromptIntakeState(path).mirroredThreadId(path,1n),NativePromptIntakeUnavailableError);
}));
test('crossed or malformed mapping replies cannot manufacture a route',async t=>{
 let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const native=createNativePromptIntakeState('missing');
 for(raw of [{ok:true,operation:'MirrorTarget',value:{channel:2n,target:'wrong'}},{ok:true,operation:'Get',value:{channel:1n,target:null}},{ok:true,operation:'MirrorTarget',value:{channel:1n,target:3}},{ok:false}])await assert.rejects(native.mirroredThreadId('missing',1n),NativePromptIntakeUnavailableError);
 raw={ok:true,operation:'MirrorTarget',value:{channel:1n,target:''}};assert.equal(await native.mirroredThreadId('missing',1n),'');
});
test('mapping deadline retains Control owner until actual native exit and cannot return late null',async()=>storeFixture(async path=>{
 await init(path);const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const native=createNativePromptIntakeState(path,10),pending=native.mirroredThreadId(path,1n),rejected=assert.rejects(pending,NativePromptIntakeUnavailableError);let finished=false;void pending.then(()=>{finished=true;},()=>{finished=true;});
 try{await new Promise(r=>setTimeout(r,100));assert.equal(finished,false);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(native.getPromptIntake(path,'missing'),OwnedWorkerBudgetError);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);}
 finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
}));
test('actual busy executor uses native mapping then atomic admission and never repeats preparation',async t=>storeFixture(async path=>{
 await init(path);edit(path,db=>db.exec("INSERT INTO busy_choices VALUES('choice',2,1,'target','raw',0,1,100,NULL,0)"));const native=createNativePromptIntakeState(path),operations:string[]=[],original=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){const payload=args[1] as {operation?:string};if(payload.operation)operations.push(payload.operation);return Reflect.apply(original,this,args);});
 let prepares=0;const executor=new BusyQueueExecutor(path,{async processAdmittedPrompt(){prepares++;return {text:'accepted',waitsForFinal:true,ui:null};}},()=>10,native.admitBusyQueue,native.mirroredThreadId),choice={choiceId:'choice',ownerUserId:2n,channelId:1n,targetThreadId:'target',prompt:'raw',allowSteer:false,createdAt:1,expiresAt:100};
 assert.equal((await executor.enqueueBusyChoice(choice)).text,'accepted');assert.match((await executor.enqueueBusyChoice(choice)).text,/already accepted/);assert.equal(prepares,1);assert.deepEqual(operations,['MirrorTarget','AdmitBusy','MirrorTarget','AdmitBusy']);assert.equal(ownedWorkerUsage().Control,0);
}));
