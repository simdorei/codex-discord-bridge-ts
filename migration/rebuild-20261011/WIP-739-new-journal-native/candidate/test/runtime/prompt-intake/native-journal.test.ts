import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {NewThreadJournal} from '../../../src/runtime/action-executor/new-journal.ts';import {newCommandPrompt} from '../../../src/store/ingress-new-input.ts';import type {NewIngress} from '../../../src/store/ingress-types.ts';
import {createNativePromptIntakeState,NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
function edit<T>(p:string,f:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(p);try{return f(db);}finally{db.close();}}
const context=()=>({channelId:99n,userId:20n,discordMessageId:30n,autoQueueWhenBusy:true});
const input=():NewIngress=>({ingressId:'i',kind:'action',eventId:30n,applicationId:null,channelId:99n,ownerUserId:20n,sourceMessageId:30n,payload:{command:'new',prompt:'raw',n:18446744073709551615n,f:1},targetThreadId:null,canonicalOwner:null,now:10});
async function init(path:string){const db=await openInitialized(path);db.close();}
test('native journal operations neither create missing store nor misrepresent unavailable reads as null',async()=>storeFixture(async path=>{
 const native=createNativePromptIntakeState(path);await assert.rejects(native.ingressByOrigin(path,30n),NativePromptIntakeUnavailableError);await assert.rejects(native.admitIngress(path,input()),NativePromptIntakeUnavailableError);await assert.rejects(native.holdIngress(path,'i','reason',true,10),NativePromptIntakeUnavailableError);assert.equal(existsSync(path),false);await init(path);assert.equal(await native.ingressByOrigin(path,30n),null);
}));
test('native admission preserves complete records, earlier duplicate IDs and outcome absence versus JSON null',async()=>storeFixture(async path=>{
 await init(path);const native=createNativePromptIntakeState(path),first=await native.admitIngress(path,input());assert.equal(first.created,true);assert.ok(first.record);assert.deepEqual(first.record,await state.getIngress(path,'i'));assert.equal(first.record.outcome,undefined);
 const again=await native.admitIngress(path,{...input(),ingressId:'other'});assert.equal(again.created,false);assert.equal(again.record?.ingressId,'i');
 edit(path,db=>db.exec("UPDATE discord_ingress_journal SET outcome_json='null',updated_at=1e999"));const observed=await native.ingressByOrigin(path,30n);assert.equal(observed?.outcome,null);assert.equal(observed?.updatedAt,Infinity);assert.deepEqual(observed,await state.ingressByOrigin(path,30n));
}));
test('actual journal uses native origin/admission/hold, retains ownership and refuses altered context or record',async t=>storeFixture(async path=>{
 await init(path);const operations:string[]=[],run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){operations.push((args[1] as {operation:string}).operation);return Reflect.apply(run,this,args);});
 const native=createNativePromptIntakeState(path),journal=new NewThreadJournal(path,()=>10,native),record=await journal.admit(context(),'raw');assert.equal(newCommandPrompt(record),'raw');assert.equal((await journal.admit(context(),'raw')).ingressId,record.ingressId);
 await assert.rejects(journal.admit({...context(),userId:21n},'raw'),/different original/);await assert.rejects(journal.hold({...record},Error('detail'),true),/original journal/);
 const error=await journal.hold(record,Error('private detail'),true);assert.match(error.message,/private detail/);const saved=await state.getIngress(path,record.ingressId);assert.equal(saved?.state,'held');assert.equal(saved?.holdReason.includes('private detail'),false);
 assert.deepEqual(operations,['IngressOrigin','IngressAdmit','IngressOrigin','IngressOrigin','IngressHold']);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native hold shares atomic notice rollback and duplicate hold emits one notice',async()=>storeFixture(async path=>{
 await init(path);const native=createNativePromptIntakeState(path);await native.admitIngress(path,input());
 edit(path,db=>db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'fixture'); END"));
 await assert.rejects(native.holdIngress(path,'i','safe',true,11),NativePromptIntakeUnavailableError);assert.equal((await state.getIngress(path,'i'))?.state,'staged');
 edit(path,db=>db.exec('DROP TRIGGER reject_notice'));await native.holdIngress(path,'i','safe',true,11);await native.holdIngress(path,'i','safe',true,12);
 assert.equal((await state.getIngress(path,'i'))?.state,'held');assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM codex_delivery_outbox').get()?.n),1);
}));
test('passive validation, blank prompt and pre-abort precede native admission and do not create DB',async()=>storeFixture(async path=>{
 const native=createNativePromptIntakeState(path),journal=new NewThreadJournal(path,()=>10,native);let hooks=0;const request=input();Object.defineProperty(request,'payload',{get(){hooks++;return {};}});await assert.rejects(native.admitIngress(path,request),TypeError);assert.equal(hooks,0);
 await assert.rejects(native.admitIngress(path,{...input(),channelId:0n}),/invalid ingress custody identity/);await assert.rejects(journal.admit(context(),'  '),/blank/);const abort=new AbortController(),reason=Error('cancel');abort.abort(reason);await assert.rejects(journal.admit(context(),'raw',abort.signal),e=>e===reason);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);
}));
test('crossed or incomplete native acknowledgements cannot fabricate journal authority',async t=>storeFixture(async path=>{
 let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const native=createNativePromptIntakeState(path);
 for(raw of [{ok:true,operation:'IngressOrigin',value:{event:31n,record:null}},{ok:true,operation:'IngressAdmit',value:{event:30n,record:null}},{ok:false}])await assert.rejects(native.ingressByOrigin(path,30n),NativePromptIntakeUnavailableError);
 for(raw of [{ok:true,operation:'IngressAdmit',value:{id:'i',created:true,canonicalRepeatCreated:false,busyChoice:null,record:null}},{ok:true,operation:'IngressAdmit',value:{id:'wrong',created:false,canonicalRepeatCreated:false,busyChoice:null,record:null}}])await assert.rejects(native.admitIngress(path,input()),NativePromptIntakeUnavailableError);
 raw={ok:true,operation:'IngressHold',value:{id:'wrong',held:true}};await assert.rejects(native.holdIngress(path,'i','reason',true,10),NativePromptIntakeUnavailableError);
}));
test('late native admission retains Control until actual exit and never returns late commit as permission',async()=>storeFixture(async path=>{
 await init(path);const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const native=createNativePromptIntakeState(path,10),request=input(),pending=native.admitIngress(path,request),rejected=assert.rejects(pending,NativePromptIntakeUnavailableError);let ended=false;void pending.then(()=>{ended=true;},()=>{ended=true;});(request.payload as Record<string,unknown>).prompt='mutated';
 try{await new Promise(r=>setTimeout(r,100));assert.equal(ended,false);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(native.ingressByOrigin(path,30n),OwnedWorkerBudgetError);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);const row=await state.getIngress(path,'i');assert.ok(row);assert.equal(newCommandPrompt(row),'raw');}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
}));

test('processed message keeps exact successful null result and malformed unused record JSON never becomes a partial read',async()=>storeFixture(async path=>{
 await init(path);const native=createNativePromptIntakeState(path);edit(path,db=>db.exec('INSERT INTO discord_processed_messages(message_id,seen_at) VALUES(30,0)'));
 assert.deepEqual(await native.admitIngress(path,{...input(),kind:'message'}),{created:false,canonicalRepeatCreated:false,record:null,busyChoice:null});
 await native.admitIngress(path,{...input(),eventId:31n});edit(path,db=>db.exec("UPDATE discord_ingress_journal SET outcome_json='{'"));await assert.rejects(native.ingressByOrigin(path,31n),NativePromptIntakeUnavailableError);
}));
test('captured journal functions reject active ports and ignore replacement after construction',async()=>storeFixture(async path=>{
 await init(path);let hooks=0;const native=createNativePromptIntakeState(path),port={...native};const journal=new NewThreadJournal(path,()=>10,port);port.ingressByOrigin=async()=>{hooks++;return null;};port.admitIngress=async()=>{hooks++;throw Error('replacement');};const record=await journal.admit(context(),'raw');assert.equal(record.eventId,30n);assert.equal(hooks,0);
 const active=Object.defineProperty({...native},'ingressByOrigin',{get(){hooks++;return native.ingressByOrigin;}});assert.throws(()=>new NewThreadJournal(path,()=>10,active),TypeError);assert.equal(hooks,0);
}));
