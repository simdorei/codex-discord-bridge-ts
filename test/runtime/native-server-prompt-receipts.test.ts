import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {promptFixture,editPromptFixture,callPromptFixture} from '../helpers/server-prompt-fixture.ts';
import {promptHttpFixture} from '../helpers/server-prompt-http-fixture.ts';
import {NativeCompletionReceiptStore,CompletionReceiptUnconfirmedError} from '../../src/runtime/completion/native-receipt-store.ts';
import {sendReceiptChunk,DiscordTransportFault} from '../../src/runtime/completion/receipt-sender.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {receiptHash} from '../../src/store/delivery-receipt-key.ts';
import {serializeSerdeValue as json} from '../../src/core/serde-json.ts';
import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';
import {ServerRequestDelivery} from '../../src/runtime/server-request-delivery.ts';
import {SentServerPromptCache,serverPromptIdentity} from '../../src/runtime/server-prompt-identity.ts';
import {buildServerPrompt} from '../../src/runtime/server-prompt.ts';
import {prepareServerPrompts,PromptRedisplayChangedError} from '../../src/runtime/server-prompt-redisplay.ts';
import {deliverServerPrompts} from '../../src/runtime/server-prompt-delivery.ts';
import {DiscordChannelClient} from '../../src/discord/channel-client.ts';
const domains=['server-request/prompt/v1','server-request/redisplay/v1'] as const;
const longInput={method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'v',questions:[{id:'q',question:'😀 example '.repeat(700),options:[{label:'One'},{label:'Two'}]}]}};
const hash=receiptHash('body'),guard={jobId:'j',threadId:'t',turnId:'v'},key=(domain:string,index=0n,channel=1n)=>json([channel,domain,'original',index]);
function rows(path:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT receipt_key,content_hash,message_id,retryable,blocked_reason FROM codex_delivery_receipts ORDER BY receipt_key').all();}finally{db.close();}}
async function initialize(path:string){const db=await openInitialized(path);db.close();}
function poison(t:TestContext){for(const name of ['beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'] as const)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));}
for(const domain of domains)test(`${domain}: exact null-guard multipart bounds and existing-only store`,async()=>storeFixture(async path=>{
 for(const [k,g] of [[key(domain),guard],[key(domain,0n,0n),null],[key(domain,0n,1n<<63n),null],[key(domain,-1n),null],[`[1,${JSON.stringify(domain)},"original",18446744073709551616]`,null]] as const)assert.throws(()=>new NativeCompletionReceiptStore(path,k,hash,g),TypeError);
 for(const bad of [domain+'/',domain.replace('/v1','/v2'),'arbitrary','async-question/v1'])assert.throws(()=>new NativeCompletionReceiptStore(path,key(bad),hash,null),TypeError);
 const k=key(domain,(1n<<64n)-1n),owner=new NativeCompletionReceiptStore(path,k,hash,null);
 try{await assert.rejects(owner.begin(k,hash,guard),TypeError);await assert.rejects(owner.begin(k,hash,null),CompletionReceiptUnconfirmedError);assert.equal(existsSync(path),false);new DatabaseSync(path).close();await assert.rejects(owner.begin(k,hash,null),CompletionReceiptUnconfirmedError);const empty=new DatabaseSync(path);try{assert.deepEqual(empty.prepare('SELECT name FROM sqlite_master').all(),[]);}finally{empty.close();}assert.equal(ownedWorkerUsage().Control,0);}finally{await owner.close();}
}));
for(const domain of domains)test(`${domain}: compatibility keeps u64 channels and implicit creation; native rejects before either`,async()=>storeFixture(async path=>{
 const channel=(1n<<64n)-1n,chunk={domain,logicalKey:'original',chunkIndex:2n,content:'body'};let sends=0;const transport={sendValidated:async()=>{sends++;return 9007199254740993n;}};
 await assert.rejects(sendReceiptChunk(path,transport,channel,chunk,[],null,undefined,true),TypeError);assert.equal(existsSync(path),false);assert.equal(sends,0);
 await sendReceiptChunk(path,transport,channel,chunk);assert.equal(sends,1);assert.equal(rows(path)[0]!.receipt_key,key(domain,2n,channel));assert.equal(rows(path)[0]!.message_id,'9007199254740993');
 const nativeChannel=(1n<<63n)-1n;await sendReceiptChunk(path,transport,nativeChannel,chunk,[],null,undefined,true);assert.equal(sends,2);assert.equal(rows(path).find(row=>row.receipt_key===key(domain,2n,nativeChannel))!.message_id,'9007199254740993');
}));
test('automatic long prompt preserves every body/nonce/hash/key byte and actual cache eviction/restart uses durable receipts',async t=>promptFixture(async(path,server,request)=>{
 const bodies:string[]=[],transport={sendValidated:async(r:{body:string})=>{bodies.push(r.body);return BigInt(100+bodies.length);}};
 await new ServerRequestDelivery(path,server,transport).process(1n,request);const compatibility=bodies.splice(0),saved=rows(path);await editPromptFixture(path,'DELETE FROM codex_delivery_receipts');poison(t);
 const original=SentServerPromptCache.prototype.remember;t.mock.method(SentServerPromptCache.prototype,'remember',function(this:SentServerPromptCache,generation:bigint,k:string){original.call(this,generation,k);for(let i=0;i<513;i++)original.call(this,generation,'eviction-'+i);assert.equal(this.contains(generation,k),false);});
 const owner=new ServerRequestDelivery(path,server,transport,true);await owner.process(1n,request);assert.deepEqual(bodies,compatibility);assert.deepEqual(rows(path),saved);await owner.process(1n,request);await new ServerRequestDelivery(path,server,transport,true).recover();assert.deepEqual(bodies,compatibility);
 assert.ok(bodies.length>2);for(const body of bodies.slice(0,-1))assert.equal(JSON.parse(body).components,undefined);assert.ok(JSON.parse(bodies.at(-1)!).components.length>0);assert.ok(bodies.every(body=>JSON.parse(body).enforce_nonce===true));
 const identity=serverPromptIdentity(1n,request,buildServerPrompt(request,1n));assert.deepEqual(saved.map(row=>parseSerdeValue(row.receipt_key as string)),bodies.map((_body,index)=>[1n,domains[0],identity,BigInt(index)]));assert.deepEqual(await callPromptFixture(server,'answers'),[]);assert.equal(ownedWorkerUsage().Control,0);
},longInput));
test('redisplay long prompt preserves compatibility bytes, original occurrence array and explicit new command intent',async t=>promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
 const prompts=await prepareServerPrompts(path,server,'t',1n,2n),context={database:path,server,http,channelId:1n,userId:2n,commandKey:'redisplay'};
 await deliverServerPrompts(context,prompts);const count=seen.length,compatibility=seen.splice(0),saved=rows(path);await editPromptFixture(path,'DELETE FROM codex_delivery_receipts');poison(t);
 await deliverServerPrompts({...context,nativePromptReceipts:true},prompts);assert.deepEqual(seen,compatibility);assert.deepEqual(rows(path),saved);await deliverServerPrompts({...context,nativePromptReceipts:true},prompts);assert.equal(seen.length,count);
 await deliverServerPrompts({...context,commandKey:'redisplay-again',nativePromptReceipts:true},prompts);assert.equal(seen.length,count*2);assert.notEqual(JSON.parse(seen[0]!.body).nonce,JSON.parse(seen[count]!.body).nonce);
 const tuple=parseSerdeValue<unknown[]>(String(saved[0]!.receipt_key)),logical=parseSerdeValue<unknown[]>(String(tuple[2]));assert.deepEqual(logical,['redisplay',1n,'approval',Array.from(prompts[0]!.request.occurrence.asBytes(),BigInt)]);assert.deepEqual(await callPromptFixture(server,'answers'),[]);
}),longInput));
for(const status of [400,429,503])test(`automatic multipart ${status} retains accepted prefix, cache only after all chunks, and retry policy`,async t=>promptFixture(async(path,server,request)=>{
 poison(t);const bodies:string[]=[],transport={sendValidated:async(r:{body:string})=>{bodies.push(r.body);if(bodies.length===2)throw new DiscordTransportFault('Response','fixture rejection',status);return BigInt(100+bodies.length);}},owner=new ServerRequestDelivery(path,server,transport,true);
 await assert.rejects(owner.process(1n,request));const first=rows(path);assert.equal(first.length,2);assert.equal(first[0]!.message_id,'101');assert.equal(first[1]!.message_id,null);assert.equal(first[1]!.retryable,status===429?1:0);assert.equal(first[1]!.blocked_reason!==null,status===400);
 if(status===429){await owner.process(1n,request);assert.equal(bodies[1],bodies[2]);assert.equal(bodies.filter(body=>body===bodies[0]).length,1);assert.ok(rows(path).every(row=>row.message_id!==null));const count=bodies.length;await new ServerRequestDelivery(path,server,transport,true).process(1n,request);assert.equal(bodies.length,count);}
 else{await assert.rejects(owner.process(1n,request),status===400?/requires correction/:/unknown/);await assert.rejects(new ServerRequestDelivery(path,server,transport,true).recover());assert.equal(bodies.length,2);}
 assert.equal(ownedWorkerUsage().Control,0);
},longInput));
test('native automatic confirmation failure keeps unknown after accepted HTTP across a recreated owner',async t=>promptFixture(async(path,server,request)=>{
 poison(t);await editPromptFixture(path,"CREATE TRIGGER reject_confirm BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(ABORT,'fixture');END");let sends=0;const transport={sendValidated:async()=>{sends++;return 91n;}};
 await assert.rejects(new ServerRequestDelivery(path,server,transport,true).process(1n,request),CompletionReceiptUnconfirmedError);await assert.rejects(new ServerRequestDelivery(path,server,transport,true).process(1n,request),/unknown/);assert.equal(sends,1);assert.equal(rows(path)[0]!.message_id,null);
}));
test('redisplay actual malformed second HTTP response retains prefix and a new command is a distinct intent',async t=>promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
 poison(t);const prompts=await prepareServerPrompts(path,server,'t',1n,2n),context={database:path,server,http,channelId:1n,userId:2n,commandKey:'unknown',nativePromptReceipts:true};
 await assert.rejects(deliverServerPrompts(context,prompts),/unconfirmed/);assert.equal(seen.length,2);assert.equal(rows(path)[0]!.message_id,'901');assert.equal(rows(path)[1]!.message_id,null);
 await assert.rejects(deliverServerPrompts(context,prompts),/unknown/);assert.equal(seen.length,2);await deliverServerPrompts({...context,commandKey:'new-explicit-command'},prompts);assert.ok(seen.length>4);assert.equal(server.pendingServerRequests().length,1);
},(_request,count,response)=>{if(count===2)response.end('{"id":"902"}');}),longInput));
test('native per-chunk redisplay refuses changed mapping and forged prepared snapshots',async t=>promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
 poison(t);const prompts=await prepareServerPrompts(path,server,'t',1n,2n),context={database:path,server,http,channelId:1n,userId:2n,commandKey:'revalidate',nativePromptReceipts:true};
 await assert.rejects(deliverServerPrompts(context,[{...prompts[0]!}]),TypeError);assert.equal(seen.length,0);await assert.rejects(deliverServerPrompts({...context,userId:99n},prompts),PromptRedisplayChangedError);assert.equal(seen.length,0);
 await assert.rejects(deliverServerPrompts(context,prompts),PromptRedisplayChangedError);assert.equal(seen.length,1);assert.equal(rows(path)[0]!.message_id,'901');assert.equal(JSON.parse(seen[0]!.body).components,undefined);
},async(_request,count)=>{if(count===1)await editPromptFixture(path,"UPDATE mirror_threads SET codex_thread_id='other'");}),longInput));
test('native prompt lost Begin acknowledgement and cancelled Begin never post or automatically replay',async t=>promptFixture(async(path,server,request)=>{
 poison(t);let begins=0,sends=0;const c=new AbortController(),run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(String(args[0]).endsWith('/native-receipt-store-worker.ts')&&++begins===1)return pending.then(value=>{c.abort(Error('cancel observed begin'));return value;});return pending;});
 const transport={sendValidated:async()=>{sends++;return 91n;}};await assert.rejects(new ServerRequestDelivery(path,server,transport,true).process(1n,request,c.signal),CompletionReceiptUnconfirmedError);await assert.rejects(new ServerRequestDelivery(path,server,transport,true).process(1n,request),/unknown/);assert.equal(sends,0);assert.equal(rows(path)[0]!.message_id,null);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native known automatic and redisplay acceptance commits despite cancellation with unchanged automatic transport signal semantics',async t=>promptFixture(async(path,server,request)=>{
 poison(t);const c=new AbortController();let sends=0;await new ServerRequestDelivery(path,server,{sendValidated:async(_request,signal)=>{sends++;assert.equal(signal,undefined);c.abort(Error('automatic shutdown'));return 91n;}},true).process(1n,request,c.signal);assert.equal(rows(path)[0]!.message_id,'91');
 const send=DiscordChannelClient.prototype.sendValidated,redisplay=new AbortController();t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){const value=await send.apply(this,args);assert.equal(args[1],redisplay.signal);redisplay.abort(Error('redisplay shutdown'));return value;});
 await promptHttpFixture(async(http,seen)=>{const prompts=await prepareServerPrompts(path,server,'t',1n,2n),context={database:path,server,http,channelId:1n,userId:2n,commandKey:'accepted',nativePromptReceipts:true};await deliverServerPrompts({...context,signal:redisplay.signal},prompts);await deliverServerPrompts(context,prompts);assert.equal(seen.length,1);assert.ok(rows(path).every(row=>row.message_id!==null));});assert.equal(sends,1);
}));
for(const domain of domains)for(const operation of ['Begin','Confirm'] as const)test(`${domain} ${operation}: timeout holds owner/Control slot until actual locked SQL exit`,async()=>storeFixture(async path=>{
 await initialize(path);const k=key(domain,2n),owner=new NativeCompletionReceiptStore(path,k,hash,null,30);if(operation==='Confirm'){const initial=new NativeCompletionReceiptStore(path,k,hash,null);try{await initial.begin(k,hash,null);}finally{await initial.close();}}
 const blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');let settled=false,ticks=0;const timer=setInterval(()=>ticks++,5),task=operation==='Begin'?owner.begin(k,hash,null):owner.confirm(k,hash,'77'),failed=assert.rejects(task,CompletionReceiptUnconfirmedError);void task.then(()=>settled=true,()=>settled=true);
 try{await new Promise(resolve=>setTimeout(resolve,150));assert.equal(settled,false);assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);assert.ok(ticks>3);blocker.exec('ROLLBACK');await failed;assert.equal(rows(path)[0]!.message_id,operation==='Confirm'?'77':null);assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);}finally{clearInterval(timer);if(blocker.isTransaction)blocker.exec('ROLLBACK');await task.catch(()=>{});await owner.close();blocker.close();}
}));
test('native prompt Begin refuses Control saturation while two original confirms retain FIFO ownership',async t=>storeFixture(async path=>{
 poison(t);await initialize(path);const firstKey=key(domains[0]),secondKey=key(domains[1]),blockKey=key(domains[0],1n),thirdKey=key(domains[1],1n),first=new NativeCompletionReceiptStore(path,firstKey,hash,null),second=new NativeCompletionReceiptStore(path,secondKey,hash,null),occupant=new NativeCompletionReceiptStore(path,blockKey,hash,null),third=new NativeCompletionReceiptStore(path,thirdKey,hash,null);
 await first.begin(firstKey,hash,null);await second.begin(secondKey,hash,null);const blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');const occupying=occupant.begin(blockKey,hash,null),order:number[]=[],a=first.confirm(firstKey,hash,'91').then(result=>{order.push(1);return result;}),b=second.confirm(secondKey,hash,'92').then(result=>{order.push(2);return result;});
 try{await assert.rejects(third.begin(thirdKey,hash,null),OwnedWorkerBudgetError);await new Promise(resolve=>setTimeout(resolve,100));assert.deepEqual(order,[]);assert.equal(ownedWorkerUsage().Control,1);blocker.exec('ROLLBACK');await occupying;assert.deepEqual(await Promise.all([a,b]),[true,true]);assert.deepEqual(order,[1,2]);assert.equal(rows(path).find(row=>row.receipt_key===thirdKey),undefined);}finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');await Promise.allSettled([occupying,a,b]);await Promise.all([first.close(),second.close(),occupant.close(),third.close()]);blocker.close();}assert.equal(ownedWorkerUsage().Control,0);
}));
for(const status of [400,429,503])test(`native redisplay real HTTP ${status} keeps the existing retry and durable outcome policy`,async t=>promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
 poison(t);const context={database:path,server,http,channelId:1n,userId:2n,commandKey:'wire-'+status,nativePromptReceipts:true},prompts=await prepareServerPrompts(path,server,'t',1n,2n);
 if(status===429){await deliverServerPrompts(context,prompts);assert.equal(seen.length,2);assert.equal(seen[0]!.body,seen[1]!.body);assert.equal(rows(path)[0]!.message_id,'902');await deliverServerPrompts(context,prompts);assert.equal(seen.length,2);}
 else{await assert.rejects(deliverServerPrompts(context,prompts));await assert.rejects(deliverServerPrompts(context,prompts),status===400?/requires correction/:/unknown/);assert.equal(seen.length,1);assert.equal(rows(path)[0]!.message_id,null);assert.equal(rows(path)[0]!.blocked_reason!==null,status===400);}
},(_request,count,response)=>{if(count===1){response.statusCode=status;response.end('{"code":50035,"message":"offline fixture","retry_after":0}');}})));
test('native redisplay explicit validated 429 release retries the same original nonce after an accepted prefix',async t=>promptFixture(async(path,server)=>{
 poison(t);const bodies:string[]=[],send=DiscordChannelClient.prototype.sendValidated;t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){bodies.push(args[0].body);if(bodies.length===2)throw new DiscordTransportFault('Response','fixture validated rate rejection',429);return send.apply(this,args);});
 await promptHttpFixture(async(http,seen)=>{const context={database:path,server,http,channelId:1n,userId:2n,commandKey:'explicit-rate',nativePromptReceipts:true},prompts=await prepareServerPrompts(path,server,'t',1n,2n);await assert.rejects(deliverServerPrompts(context,prompts));assert.equal(rows(path)[1]!.retryable,1);assert.equal(seen.length,1);await deliverServerPrompts(context,prompts);assert.equal(bodies[1],bodies[2]);assert.equal(bodies.filter(body=>body===bodies[0]).length,1);assert.ok(rows(path).every(row=>row.message_id!==null));});
},longInput));
test('native redisplay accepted HTTP with failed confirmation remains unknown for the same command',async t=>promptFixture(async(path,server)=>promptHttpFixture(async(http,seen)=>{
 poison(t);await editPromptFixture(path,"CREATE TRIGGER reject_redisplay_confirm BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(ABORT,'fixture');END");const context={database:path,server,http,channelId:1n,userId:2n,commandKey:'confirm-failure',nativePromptReceipts:true},prompts=await prepareServerPrompts(path,server,'t',1n,2n);
 await assert.rejects(deliverServerPrompts(context,prompts),CompletionReceiptUnconfirmedError);await assert.rejects(deliverServerPrompts(context,prompts),/unknown/);assert.equal(seen.length,1);assert.equal(rows(path)[0]!.message_id,null);
})));
