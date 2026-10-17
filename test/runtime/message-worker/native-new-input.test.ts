import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {newExecutionPrompt} from '../../../src/store/ingress-new-input.ts';
import {createNativeMessageJournal,captureMessageJournal,admitOriginalMessageJournal,NativeMessageJournalUnavailableError} from '../../../src/runtime/message-worker/journal.ts';
import {MessageCustody} from '../../../src/runtime/message-worker/custody.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
const id=9007199254740993n,key=`message:${id}`,raw='raw',prepared='prepared abc';
const input=()=>({ingressId:key,kind:'message' as const,eventId:id,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:id,payload:{version:1n,content:'!new raw',plan:{Execute:{New:{prompt:raw}}},attachments:[{id:10n,filename:'a.txt',size:3n}]},targetThreadId:null,canonicalOwner:null,now:1});
async function setup(path:string,timeout=5000){(await openInitialized(path)).close();const port=createNativeMessageJournal(path,timeout),{owner}=await admitOriginalMessageJournal(path,input(),port);assert.ok(owner);const c=new MessageCustody(path,key,{messageJournal:port,now:()=>5,report:()=>assert.fail('hold failed')},owner);await c.begin(null);return {c,port};}
function poison(t:TestContext){t.mock.method(state,'recordNewInput',()=>assert.fail('compatibility New input'));}
test('original custody captures native New input and retains hashes and raw plan before result/confirmation',async t=>storeFixture(async path=>{
 (await openInitialized(path)).close();poison(t);const native=createNativeMessageJournal(path),source={...native},port=captureMessageJournal(path,source),q=input(),admitted=admitOriginalMessageJournal(path,q,port);q.payload.plan.Execute.New.prompt='mutated';q.payload.attachments[0]!.filename='mutated';const {owner}=await admitted;assert.ok(owner);
 const c=new MessageCustody(path,key,{messageJournal:port,now:()=>5,report:()=>assert.fail('hold')},owner);await c.begin(null);const pending=c.newInput(raw,prepared,3);source.recordNewInput=async()=>assert.fail('replaced New input');await pending;
 const before=(await state.getIngress(path,key))!;assert.equal(newExecutionPrompt(before),prepared);assert.deepEqual((before.payload as any).plan,{Execute:{New:{prompt:raw}}});assert.equal((before.payload as any).attachments[0].filename,'a.txt');await c.record({response:'created'},4);await c.finish();await c.dispose();assert.deepEqual((await state.getIngress(path,key))!.outcome,{response:'created',new_input:(before.outcome as any).new_input});assert.equal(ownedWorkerUsage().Control,0);
}));
test('public and original New input both refuse Control saturation; only the subsequent hold queues',async t=>storeFixture(async path=>{
 poison(t);const {c,port}=await setup(path),blocker=new OwnedWorkerSlot('Control'),url=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort} from 'node:worker_threads';setTimeout(()=>parentPort.postMessage(true),250);")),busy=blocker.run(url,{},1000);
 await assert.rejects(port.recordNewInput(path,key,raw,prepared,3),OwnedWorkerBudgetError);await assert.rejects(c.newInput(raw,prepared,3),OwnedWorkerBudgetError);assert.equal((await state.getIngress(path,key))!.outcome,undefined);
 const disposal=c.dispose();let settled=false;void disposal.then(()=>settled=true);await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);await busy;await blocker.join();await disposal;assert.equal((await state.getIngress(path,key))!.state,'held');assert.equal((await state.getIngress(path,key))!.outcome,undefined);
}));
for(const field of ['operation','path','id','origin','owner','requestId','value','missing'] as const)test(`crossed or malformed NewInput ${field} ACK remains unknown after commit and never replays`,async t=>storeFixture(async path=>{
 poison(t);const {c,port}=await setup(path),run=OwnedWorkerSlot.prototype.run;let writes=0;
 t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const value=await run.apply(this,args) as any;if((args[1] as any).operation==='NewInput'){writes++;if(field==='missing')return {ok:true};value[field]=field==='value'?1:'foreign';}return value;});
 await assert.rejects(c.newInput(raw,prepared,3),e=>e instanceof NativeMessageJournalUnavailableError&&e.operation==='NewInput');await c.dispose();const row=(await state.getIngress(path,key))!;assert.equal(row.state,'held');assert.equal(newExecutionPrompt(row),prepared);assert.equal((await admitOriginalMessageJournal(path,input(),port)).owner,null);assert.equal(writes,1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('lost NewInput ACK retains actual native exit ownership before disposal can submit required hold',async t=>storeFixture(async path=>{
 poison(t);const {c}=await setup(path),trace=new SharedArrayBuffer(8),extension=import.meta.url.endsWith('.js')?'.js':'.ts',restore=instrumentStoreWorker({match:'native-journal-worker'+extension,trace,ack:'drop'});
 const pending=c.newInput(raw,prepared,3),failed=assert.rejects(pending,NativeMessageJournalUnavailableError);let disposal:Promise<void>|undefined,settled=false;
 try{await waitTrace(trace);disposal=c.dispose();void disposal.then(()=>settled=true);await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);restore();releaseTrace(trace);await failed;await disposal;assert.equal((await state.getIngress(path,key))!.state,'held');assert.equal(newExecutionPrompt((await state.getIngress(path,key))!),prepared);}finally{restore();releaseTrace(trace);await pending.catch(()=>{});await (disposal??c.dispose());}
}));
test('NewInput deadline cannot release a locked writer or disposal custody before actual exit',()=>storeFixture(async path=>{
 const {c}=await setup(path,500),db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const pending=c.newInput(raw,prepared,3),failed=assert.rejects(pending,NativeMessageJournalUnavailableError),disposal=c.dispose();let settled=false;void disposal.then(()=>settled=true);
 try{await new Promise(r=>setTimeout(r,650));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await failed;await disposal;assert.equal(newExecutionPrompt((await state.getIngress(path,key))!),prepared);assert.equal((await state.getIngress(path,key))!.state,'held');}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});await disposal;db.close();}
}));
test('NewInput rejects active primitives and foreign path before worker submission',async t=>storeFixture(async path=>{
 const {c,port}=await setup(path);let coercions=0,submissions=0;const hostile={toString(){coercions++;return raw;}};const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){submissions++;return run.apply(this,args);});
 assert.throws(()=>c.newInput(hostile as unknown as string,prepared,3),TypeError);await assert.rejects(port.recordNewInput('foreign',key,raw,prepared,3),TypeError);assert.equal(coercions,0);assert.equal(submissions,0);await c.dispose();
}));
