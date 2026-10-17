import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {receiptHash} from '../../../src/store/delivery-receipt-key.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {DiscordTransportFault} from '../../../src/runtime/completion/receipt-sender.ts';
import {NativeCompletionReceiptStore, CompletionReceiptUnconfirmedError} from '../../../src/runtime/completion/native-receipt-store.ts';
import {OwnedWorkerSlot, OwnedWorkerBudgetError, ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {standardConfirmationPlan,busyConfirmationPlan,asyncQuestionConfirmationPlan,publicationIntentConfirmationPlan,abandonmentConfirmationPlan,confirmationErrorInfo,type ConfirmationPlan} from '../../../src/runtime/component-worker/confirmation.ts';
import {deliverConfirmationAndClear} from '../../../src/runtime/component-worker/confirmation-delivery.ts';
const plans=()=>[standardConfirmationPlan({Approval:{thread_id:'t',answer:'Approve'}},'original 😀'),busyConfirmationPlan('original 😀'),asyncQuestionConfirmationPlan('original 😀'),publicationIntentConfirmationPlan('a'.repeat(32),1n,'KeepHeld'),abandonmentConfirmationPlan('a'.repeat(32),1n,'KeepHeld')];
const key=(plan:ConfirmationPlan,channel=1n,index=0n)=>serializeSerdeValue([channel,plan.domain,plan.logicalKey,index]);
function read(path:string,k?:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT * FROM codex_delivery_receipts'+(k===undefined?'':' WHERE receipt_key=?')).get(...(k===undefined?[]:[k]));}finally{db.close();}}
async function initialize(path:string){const db=await openInitialized(path);db.close();}
type Request={method:string;url:string;body:string};
async function http(run:(client:DiscordChannelClient,seen:Request[])=>Promise<void>,response:(request:Request,count:number)=>number=()=>200){
 const seen:Request[]=[],errors:unknown[]=[],server=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  const item={method:req.method!,url:req.url!,body};seen.push(item);try{res.statusCode=response(item,seen.length);if(res.statusCode>=400)res.end('{"code":50035,"message":"offline fixture"}');else if(item.method==='PATCH'){res.statusCode=204;res.end();}else res.end(JSON.stringify({attachments:[],author:{id:'1',username:'fixture',discriminator:'0'},channel_id:item.url.split('/')[4],content:'',embeds:[],id:'9007199254740993',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false}));}catch(error){errors.push(error);res.statusCode=500;res.end('{}');}
 });});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const client=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v10/`,report:()=>{}});
 try{await run(client,seen);assert.deepEqual(errors,[]);}finally{await client.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));assert.equal(client.activeRequests,0);assert.equal(client.ownedSockets,0);assert.equal(ownedWorkerUsage().Control,0);}
}
for(const plan of plans())test(`${plan.domain}: native profile accepts only original null-guard index-zero identity and refuses missing store`,async()=>storeFixture(async path=>{
 const hash=receiptHash(plan.content),guard={jobId:'j',threadId:'t',turnId:'v'};
 for(const [k,g] of [[key(plan),guard],[key(plan,1n,1n),null],[key(plan,0n),null],[key(plan,1n<<63n),null]] as const)assert.throws(()=>new NativeCompletionReceiptStore(path,k,hash,g),TypeError);
 for(const domain of ['component/confirmation/v2','component/busy-confirmation/v1/','arbitrary','async-question-confirmation-v1/','recovery-publication-intent-confirmation-v1/','recovery-abandonment-confirmation-v1/','recovery-publication-review-v1','recovery-abandonment-review-v1'])assert.throws(()=>new NativeCompletionReceiptStore(path,serializeSerdeValue([1n,domain,'original',0n]),hash,null),TypeError);
 const store=new NativeCompletionReceiptStore(path,key(plan),hash,null);try{await assert.rejects(store.begin(key(plan),hash,guard),TypeError);await assert.rejects(store.begin(key(plan),hash,null),CompletionReceiptUnconfirmedError);assert.equal(existsSync(path),false);new DatabaseSync(path).close();await assert.rejects(store.begin(key(plan),hash,null),CompletionReceiptUnconfirmedError);const empty=new DatabaseSync(path);try{assert.deepEqual(empty.prepare('SELECT name FROM sqlite_master').all(),[]);}finally{empty.close();}}finally{await store.close();}
}));
for(const plan of plans())test(`${plan.domain}: explicit native receipt commits before independent u64 source PATCH and clear retry`,async()=>storeFixture(async path=>{
 await initialize(path);const source=(1n<<64n)-1n;await http(async(client,seen)=>{
  await assert.rejects(deliverConfirmationAndClear(client,path,1n,source,plan,undefined,true),e=>confirmationErrorInfo(e)?.kind==='Clear');
  await deliverConfirmationAndClear(client,path,1n,source,plan,undefined,true);assert.deepEqual(seen.map(x=>x.method),['POST','PATCH','PATCH']);assert.equal(seen[1]!.url,`/api/v10/channels/1/messages/${source}`);assert.equal(seen[1]!.body,'{"components":[]}');assert.equal(read(path)!.receipt_key,key(plan));assert.equal(read(path)!.content_hash,receiptHash(plan.content));assert.equal(JSON.parse(seen[0]!.body).enforce_nonce,true);
 },(request,count)=>{const saved=read(path)!;assert.equal(saved.message_id,request.method==='POST'?null:'9007199254740993');return request.method==='PATCH'&&count===2?400:200;});
}));
test('direct helper retains implicit initialization and full u64 channel compatibility; native channel remains positive i64',async()=>storeFixture(async path=>http(async(client,seen)=>{
 const plan=busyConfirmationPlan('compatibility'),channel=(1n<<64n)-1n;
 await assert.rejects(deliverConfirmationAndClear(client,path,channel,null,plan,undefined,true),e=>confirmationErrorInfo(e)?.kind==='Delivery');assert.equal(existsSync(path),false);assert.equal(seen.length,0);
 await deliverConfirmationAndClear(client,path,channel,null,plan);assert.equal(existsSync(path),true);assert.equal(read(path)!.receipt_key,key(plan,channel));assert.deepEqual(seen.map(x=>x.method),['POST']);
})));
test('native plan authority, invalid identities, profile and excluded domains fail before HTTP or database creation',async()=>storeFixture(async path=>http(async(client,seen)=>{
 const plan=busyConfirmationPlan('original');await assert.rejects(deliverConfirmationAndClear(client,path,1n,null,{...plan},undefined,true),TypeError);
 for(const id of [0n,-1n,1n<<64n])await assert.rejects(deliverConfirmationAndClear(client,path,1n,id,plan,undefined,true),TypeError);
 await assert.rejects(deliverConfirmationAndClear(client,path,1n,null,plan,undefined,1 as never),TypeError);
 // Recovery decision domains are covered by the explicit native plan matrix above.
 const c=new AbortController(),reason=Error('cancelled');c.abort(reason);await assert.rejects(deliverConfirmationAndClear(client,path,1n,null,plan,c.signal,true),e=>e===reason);assert.deepEqual(seen,[]);assert.equal(existsSync(path),false);
})));
for(const status of [400,503])test(`native ${status} preserves original receipt disposition and nonce without implicit resend`,async t=>storeFixture(async path=>{
 for(const name of ['beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'] as const)t.mock.method(state,name,()=>assert.fail('main-thread receipt fallback'));
 const operations:string[]=[],complete=OwnedWorkerSlot.prototype.runControlCompletion;t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(String(args[0]).endsWith('/native-receipt-store-worker.ts'))operations.push((args[1] as {operation:string}).operation);return complete.apply(this,args);});
 await initialize(path);const plan=asyncQuestionConfirmationPlan('rejection');await http(async(client,seen)=>{
  await assert.rejects(deliverConfirmationAndClear(client,path,1n,9n,plan,undefined,true),e=>confirmationErrorInfo(e)?.kind==='Delivery');const saved=read(path)!;assert.equal(saved.retryable,0);assert.equal(saved.message_id,null);assert.equal(saved.blocked_reason===null,status!==400);
  await assert.rejects(deliverConfirmationAndClear(client,path,1n,9n,plan,undefined,true));assert.deepEqual(seen.map(x=>x.method),['POST']);
 },(_request,count)=>count===1?status:200);assert.deepEqual(operations,status===400?['Block']:[]);
}));
test('owned validated 429 rejection releases native intent and explicit retry preserves the exact nonce',async t=>storeFixture(async path=>{
 await initialize(path);const bodies:string[]=[],operations:string[]=[],send=DiscordChannelClient.prototype.sendValidated,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 for(const name of ['beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'] as const)t.mock.method(state,name,()=>assert.fail('main-thread receipt fallback'));
 t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){bodies.push(args[0].body);if(bodies.length===1)throw new DiscordTransportFault('Response','validated fixture rate rejection',429);return send.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(String(args[0]).endsWith('/native-receipt-store-worker.ts'))operations.push((args[1] as {operation:string}).operation);return complete.apply(this,args);});
 await http(async(client,seen)=>{const plan=asyncQuestionConfirmationPlan('rate rejection');await assert.rejects(deliverConfirmationAndClear(client,path,1n,9n,plan,undefined,true),e=>confirmationErrorInfo(e)?.kind==='Delivery');assert.equal(read(path)!.retryable,1);assert.equal(seen.length,0);await deliverConfirmationAndClear(client,path,1n,9n,plan,undefined,true);assert.equal(bodies[0],bodies[1]);assert.equal(read(path)!.message_id,'9007199254740993');assert.deepEqual(operations,['Release','Confirm']);assert.deepEqual(seen.map(x=>x.method),['POST','PATCH']);});
}));
test('actual HTTP429 keeps existing client retry behavior with stable nonce inside one native receipt intent',async()=>storeFixture(async path=>{
 await initialize(path);await http(async(client,seen)=>{await deliverConfirmationAndClear(client,path,1n,9n,busyConfirmationPlan('wire retry'),undefined,true);assert.deepEqual(seen.map(x=>x.method),['POST','POST','PATCH']);assert.equal(seen[0]!.body,seen[1]!.body);assert.equal(read(path)!.message_id,'9007199254740993');},(_request,count)=>count===1?429:200);
}));
test('native failed confirmation keeps unknown intent, never clears and never resends accepted POST',async()=>storeFixture(async path=>{
 await initialize(path);const db=new DatabaseSync(path);db.exec("CREATE TRIGGER refuse_confirm BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(ABORT,'fixture refusal'); END");db.close();
 await http(async(client,seen)=>{const plan=asyncQuestionConfirmationPlan('failed confirm');for(let i=0;i<2;i++)await assert.rejects(deliverConfirmationAndClear(client,path,1n,9n,plan,undefined,true),e=>confirmationErrorInfo(e)?.kind==='Delivery');assert.deepEqual(seen.map(x=>x.method),['POST']);assert.equal(read(path)!.message_id,null);assert.equal(read(path)!.retryable,0);});
}));
test('known accepted HTTP is confirmed after caller cancellation and only PATCH waits for an explicit later retry',async t=>storeFixture(async path=>{
 await initialize(path);const c=new AbortController(),reason=Error('caller stopped'),send=DiscordChannelClient.prototype.sendValidated;
 t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){const message=await send.apply(this,args);c.abort(reason);return message;});
 await http(async(client,seen)=>{const plan=busyConfirmationPlan('cancel accepted');await assert.rejects(deliverConfirmationAndClear(client,path,1n,9n,plan,c.signal,true),e=>e===reason);assert.deepEqual(seen.map(x=>x.method),['POST']);assert.equal(read(path)!.message_id,'9007199254740993');await deliverConfirmationAndClear(client,path,1n,9n,plan,undefined,true);assert.deepEqual(seen.map(x=>x.method),['POST','PATCH']);});
}));
test('lost native Begin acknowledgement joins original intent and prohibits POST and later automatic resend',async t=>storeFixture(async path=>{
 await initialize(path);let begins=0;const run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).endsWith('/native-receipt-store-worker.ts')&&(args[1] as {operation:string}).operation==='Begin'&&++begins===1)return task.then(()=>{throw Error('lost receipt ACK');});return task;});
 await http(async(client,seen)=>{const plan=asyncQuestionConfirmationPlan('unknown begin');for(let i=0;i<2;i++)await assert.rejects(deliverConfirmationAndClear(client,path,1n,9n,plan,undefined,true),e=>confirmationErrorInfo(e)?.kind==='Delivery');assert.deepEqual(seen,[]);assert.equal(begins,2);assert.equal(read(path)!.message_id,null);});
}));
for(const operation of ['Begin','Confirm'] as const)test(`native confirmation ${operation} deadline retains slot through lock wait and actual late exit`,async()=>storeFixture(async path=>{
 await initialize(path);const plan=busyConfirmationPlan('locked'),k=key(plan),hash=receiptHash(plan.content),store=new NativeCompletionReceiptStore(path,k,hash,null,30);
 if(operation==='Confirm'){const initial=new NativeCompletionReceiptStore(path,k,hash,null);try{await initial.begin(k,hash,null);}finally{await initial.close();}}const blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');let settled=false,ticks=0;const timer=setInterval(()=>ticks++,5),task=operation==='Begin'?store.begin(k,hash,null):store.confirm(k,hash,'77'),failed=assert.rejects(task,CompletionReceiptUnconfirmedError);void task.then(()=>settled=true,()=>settled=true);
 try{await new Promise(resolve=>setTimeout(resolve,150));assert.equal(settled,false);assert.equal(store.busy,true);assert.equal(ownedWorkerUsage().Control,1);assert.ok(ticks>3);blocker.exec('ROLLBACK');await failed;assert.equal(store.busy,false);assert.equal(ownedWorkerUsage().Control,0);assert.equal(read(path)!.message_id,operation==='Confirm'?'77':null);}finally{clearInterval(timer);if(blocker.isTransaction)blocker.exec('ROLLBACK');await task.catch(()=>{});await store.close();blocker.close();}
}));
test('native original Begin refuses Control saturation; owned Confirm waits FIFO without compatibility fallback',async t=>storeFixture(async path=>{
 await initialize(path);for(const name of ['beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'] as const)t.mock.method(state,name,()=>assert.fail('synchronous receipt fallback'));
 const p=busyConfirmationPlan('owned'),k=key(p),h=receiptHash(p.content),owned=new NativeCompletionReceiptStore(path,k,h,null),first=new NativeCompletionReceiptStore(path,key(busyConfirmationPlan('blocker')),h,null),third=new NativeCompletionReceiptStore(path,key(busyConfirmationPlan('unstarted')),h,null);await owned.begin(k,h,null);const blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');const occupying=first.begin(key(busyConfirmationPlan('blocker')),h,null);let confirmed=false;
 const confirm=owned.confirm(k,h,'99').then(value=>{confirmed=true;return value;});
 try{await assert.rejects(third.begin(key(busyConfirmationPlan('unstarted')),h,null),OwnedWorkerBudgetError);await new Promise(resolve=>setTimeout(resolve,100));assert.equal(confirmed,false);assert.equal(ownedWorkerUsage().Control,1);blocker.exec('ROLLBACK');await occupying;assert.equal(await confirm,true);assert.equal(read(path,k)!.message_id,'99');assert.equal(read(path,key(busyConfirmationPlan('unstarted'))),undefined);}finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');await Promise.allSettled([occupying,confirm]);await Promise.all([owned.close(),first.close(),third.close()]);blocker.close();}
}));

test('native confirmation without a source message commits delivery without PATCH',async()=>storeFixture(async path=>{
 await initialize(path);await http(async(client,seen)=>{await deliverConfirmationAndClear(client,path,1n,null,busyConfirmationPlan('no source'),undefined,true);assert.deepEqual(seen.map(x=>x.method),['POST']);assert.equal(read(path)!.message_id,'9007199254740993');});
}));
