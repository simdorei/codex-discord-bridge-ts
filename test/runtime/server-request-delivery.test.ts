import {parseComponentId} from '../../src/discord/components.ts';
import {buildComponentResponse} from '../../src/runtime/component-worker/response.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {promptFixture,editPromptFixture,callPromptFixture} from '../helpers/server-prompt-fixture.ts';
import {ServerRequestDelivery,ServerRequestGenerationMismatch} from '../../src/runtime/server-request-delivery.ts';
import {serverPromptIdentity,SentServerPromptCache,SERVER_REQUEST_PROMPT_DOMAIN} from '../../src/runtime/server-prompt-identity.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import {PortableResidentLifecycle} from '../../src/app-server/portable-resident-lifecycle.ts';
import {buildServerPrompt} from '../../src/runtime/server-prompt.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {approvalButtonRow} from '../../src/discord/components.ts';

test('semantic identity matches independent Python golden and separates every source-bound field',()=>{
 const request={id:42n,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(0x11)),method:'item/commandExecution/requestApproval',params:{}},prompt={threadId:'thread-1',text:'same prompt',components:[]};
 const key=serverPromptIdentity(1n,request,prompt);assert.equal(key,'1:42:a96620ce6449727bcf18ade103c0e76e3e8edc8f6cc10de34fe6bcd42bd2f828');assert.equal(SERVER_REQUEST_PROMPT_DOMAIN,'server-request/prompt/v1');
 for(const [generation,r,p] of [[2n,request,prompt],[1n,{...request,id:'42'},prompt],[1n,{...request,method:'other'},prompt],[1n,{...request,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(0x22))},prompt],[1n,request,{...prompt,threadId:'thread-2'}],[1n,request,{...prompt,text:'same prompt!'}],[1n,request,{...prompt,components:[approvalButtonRow('thread-1')]}]] as const)assert.notEqual(serverPromptIdentity(generation,r,p),key);
 assert.throws(()=>serverPromptIdentity(1n,request,{...prompt,components:[{...approvalButtonRow('thread-1')}]}));
 let hooks=0;assert.throws(()=>serverPromptIdentity(1n,request,Object.defineProperty({...prompt},'text',{get(){hooks++;return 'x';}})),TypeError);assert.equal(hooks,0);
});
test('sent cache is FIFO 512, duplicate does not refresh order and generation changes clear all keys',()=>{
 const c=new SentServerPromptCache();for(let n=0;n<512;n++)c.remember(1n,String(n));c.remember(1n,'0');c.remember(1n,'512');assert.equal(c.size,512);assert.equal(c.contains(1n,'0'),false);assert.equal(c.contains(1n,'1'),true);assert.equal(c.contains(2n,'1'),false);assert.equal(c.size,0);assert.throws(()=>c.remember(-1n,'x'));
});
test('actual pending approval sends once across cache repeat and recreated worker using durable receipt',async()=>promptFixture(async(path,server,request)=>{
 const bodies:string[]=[],transport={sendValidated:async(r:{body:string})=>{bodies.push(r.body);return 91n;}};const worker=new ServerRequestDelivery(path,server,transport);
 await worker.process(1n,request);await worker.process(1n,request);await new ServerRequestDelivery(path,server,transport).recover();assert.equal(bodies.length,1);assert.ok(JSON.parse(bodies[0]!).components.length>0);assert.equal(JSON.parse(bodies[0]!).enforce_nonce,true);assert.equal(server.pendingServerRequests().length,1);assert.deepEqual(await callPromptFixture(server,'answers'),[]);
 const db=await openInitialized(path);try{const receipt=db.prepare('SELECT receipt_key,message_id FROM codex_delivery_receipts').get()!;assert.ok(String(receipt.receipt_key).includes('server-request/prompt/v1'));assert.equal(receipt.message_id,'91');}finally{db.close();}
}));
test('accepted HTTP with failed durable confirmation stays unknown across new workers and never posts twice',async()=>promptFixture(async(path,server,request)=>{
 await editPromptFixture(path,"CREATE TRIGGER reject_receipt BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(ABORT,'receipt failed');END");let sends=0;const transport={sendValidated:async()=>{sends++;return 92n;}};
 await assert.rejects(new ServerRequestDelivery(path,server,transport).process(1n,request),/receipt failed/);await assert.rejects(new ServerRequestDelivery(path,server,transport).process(1n,request),/unknown/);assert.equal(sends,1);
}));
test('known acceptance during shutdown is recorded, joined and reused without another HTTP call',async()=>promptFixture(async(path,server,request)=>{
 const abort=new AbortController();let sends=0;const transport={sendValidated:async()=>{sends++;abort.abort('shutdown');return 93n;}};
 await new ServerRequestDelivery(path,server,transport).process(1n,request,abort.signal);await new ServerRequestDelivery(path,server,transport).process(1n,request);assert.equal(sends,1);
}));
test('stale generation and secret request fail before transport; cache still revalidates expired authority',async()=>promptFixture(async(path,server,request)=>{
 let sends=0;const w=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 94n;}});await assert.rejects(w.process(2n,request),ServerRequestGenerationMismatch);await assert.rejects(w.process(1n,{...request,method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'v',questions:[{isSecret:true}]}}),/secret/);assert.equal(sends,0);
 await w.process(1n,request);await callPromptFixture(server,'finish');await assert.rejects(w.process(1n,request),/no longer active/);assert.equal(sends,1);
}));
test('multi-chunk prompt rechecks original delivery channel before each part and retains accepted prefix',async()=>promptFixture(async(path,server,request)=>{
 let sends=0;const w=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;await editPromptFixture(path,'UPDATE codex_turn_queue SET channel_id=2');return 95n;}});
 assert.ok(buildServerPrompt(request,1n).text.length>3000);await assert.rejects(w.process(1n,request),/original delivery channel changed/);assert.equal(sends,1);
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n,1);}finally{db.close();}
},{method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'v',questions:[{id:'q',question:'a'.repeat(5000)}]}}));
test('recovery attempts valid pending requests after first failure and returns the first error',async()=>promptFixture(async(path,server,request)=>{
 const proto=PortableResidentLifecycle.prototype,original=proto.pendingServerRequests;let sends=0;
 proto.pendingServerRequests=function(thread=null){const values=original.call(this,thread);return [{...request,id:'bad',params:{}},...values];};
 try{await assert.rejects(new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 96n;}}).recover(),/missing original thread/);assert.equal(sends,1);}finally{proto.pendingServerRequests=original;}
}));

test('multi-chunk input attaches real owned components only to final part and reuses all receipts',async()=>promptFixture(async(path,server,request)=>{
 const bodies:Array<{components:unknown[]}>=[],transport={sendValidated:async(r:{body:string})=>{bodies.push(JSON.parse(r.body));return BigInt(100+bodies.length);}};
 await new ServerRequestDelivery(path,server,transport).process(1n,request);assert.ok(bodies.length>1);assert.ok(bodies.at(-1)!.components.length>0);for(const b of bodies.slice(0,-1))assert.equal(b.components?.length??0,0);const first=bodies.length;await new ServerRequestDelivery(path,server,transport).process(1n,request);assert.equal(bodies.length,first);
},{method:'item/tool/requestUserInput',params:{threadId:'t',turnId:'v',questions:[{id:'q',question:'b'.repeat(5000),options:[{label:'yes',description:'confirmed'}]}]}}));
test('one delivery owner rejects concurrent cycles and retains the in-flight send until its receipt is saved',async()=>promptFixture(async(path,server,request)=>{
 let enter!:()=>void,release!:()=>void;const started=new Promise<void>(r=>enter=r),wait=new Promise<void>(r=>release=r);let sends=0;
 const worker=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;enter();await wait;return 97n;}}),running=worker.process(1n,request);
 try{await Promise.race([started,running]);await assert.rejects(worker.recover(),/already owned/);await assert.rejects(worker.process(1n,request),/already owned/);assert.equal(sends,1);}finally{release();await running;}await worker.recover();assert.equal(sends,1);
}));

for(const allowed of [true,false])test('empty approval is accepted and data-entry form stays pending; empty='+allowed,async()=>promptFixture(async(path,server,request)=>{
 let sends=0;const worker=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 98n;}});
 await worker.process(1n,request);assert.equal(sends,allowed?0:1);assert.equal(server.pendingServerRequests().length,allowed?0:1);
 const answers=await callPromptFixture(server,'answers') as Array<{result:unknown}>;
 if(allowed){assert.equal(answers.length,1);assert.deepEqual(answers[0]!.result,{action:'accept',content:{},_meta:null});await assert.rejects(worker.process(1n,request));}
 else{assert.deepEqual(answers,[]);await worker.process(1n,request);assert.equal(sends,1);}
 assert.equal((await callPromptFixture(server,'answers') as unknown[]).length,allowed?1:0);
},{enableResponses:true,method:'mcpServer/elicitation/request',params:{threadId:'t',turnId:'v',mode:'openai/form',serverName:'node_repl',_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'browser',riskLevel:'low'},requestedSchema:{type:'object',properties:allowed?{}:{answer:{type:'string'}},required:allowed?[]:['answer']}}}));

test('local form never responds after original turn completion or generation mismatch',async()=>promptFixture(async(path,server,request)=>{
 const worker=new ServerRequestDelivery(path,server,{sendValidated:async()=>{throw new Error('must not send');}});
 await assert.rejects(worker.process(2n,request),ServerRequestGenerationMismatch);
 await callPromptFixture(server,'finish');await assert.rejects(worker.process(1n,request),/no longer active/);
 assert.deepEqual(await callPromptFixture(server,'answers'),[]);
},{enableResponses:true,method:'mcpServer/elicitation/request',params:{threadId:'t',turnId:'v',mode:'form',serverName:'node_repl',_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',riskLevel:'low'},requestedSchema:{type:'object',properties:{}}}}));

for(const bad of ['unowned','wrong-queue-generation','remapped','expired-occurrence'] as const)test('local form original authority rejects '+bad,async()=>promptFixture(async(path,server,request)=>{
 if(bad==='unowned')await editPromptFixture(path,'UPDATE codex_turn_queue SET owner_user_id=NULL');
 if(bad==='wrong-queue-generation')await editPromptFixture(path,'UPDATE codex_turn_queue SET app_server_generation=999');
 if(bad==='remapped')await editPromptFixture(path,"UPDATE mirror_threads SET codex_thread_id='other'");
 const supplied=bad==='expired-occurrence'?{...request,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(99))}:request;
 await assert.rejects(new ServerRequestDelivery(path,server,{sendValidated:async()=>{throw new Error('must not send');}}).process(1n,supplied));
 assert.deepEqual(await callPromptFixture(server,'answers'),[]);assert.equal(server.pendingServerRequests().length,1);
},{enableResponses:true,method:'mcpServer/elicitation/request',params:{threadId:'t',turnId:'v',mode:'form',serverName:'node_repl',_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',riskLevel:'low',persist:['session','always']},requestedSchema:{type:'object',properties:{}}}}));

const savedChromeConfig={layers:[{name:{type:'user',file:'C:/Users/test/.codex/config.toml'},config:{computer_use:{windows:{always_allowed_app_ids:['Chrome']}}}}]};
const chromeAccess={threadId:'t',turnId:'v',mode:'form',serverName:'node_repl',message:'Allow Codex to use Google Chrome?',_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',riskLevel:'high',persist:['session','always'],tool_params:{app:'Chrome'}},requestedSchema:{type:'object',properties:{}}};
test('saved Chrome access uses its original bound response without an approval prompt',async()=>promptFixture(async(path,server,request)=>{
 let sends=0;const worker=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 99n;}});
 await worker.process(1n,request);
 assert.equal(sends,0,'the saved user grant must suppress the redundant prompt');
 const answers=await callPromptFixture(server,'answers') as Array<{result:unknown}>;
 assert.deepEqual(answers.map(x=>x.result),[{action:'accept',content:{},_meta:{persist:'always'}}]);
 assert.equal(server.pendingServerRequests().length,0);
 await assert.rejects(worker.process(1n,request));
 assert.equal((await callPromptFixture(server,'answers') as unknown[]).length,1);
},{enableResponses:true,method:'mcpServer/elicitation/request',params:chromeAccess,configResponse:savedChromeConfig}));

test('high-risk access without a saved grant reaches the owner and the generated button answers the exact request',async()=>promptFixture(async(path,server,request)=>{
 const bodies:string[]=[];
 await new ServerRequestDelivery(path,server,{sendValidated:async(r:{body:string})=>{bodies.push(r.body);return 109n;}}).process(1n,request);
 assert.equal(bodies.length,1);assert.equal(server.pendingServerRequests().length,1);
 assert.deepEqual(await callPromptFixture(server,'answers'),[]);
 const component=parseComponentId(JSON.parse(bodies[0]!).components[0].components[0].custom_id)!;
 const response=buildComponentResponse(component,[request],1n);
 assert.deepEqual(response.payload,{action:'accept',content:{},_meta:null});
 assert.equal(response.occurrence.equals(request.occurrence),true);
 assert.throws(()=>buildComponentResponse(component,[request],2n));
},{enableResponses:true,method:'mcpServer/elicitation/request',params:chromeAccess}));
test('saved access revalidates original ownership after the asynchronous config read',async()=>promptFixture(async(path,server,request)=>{
 const proto=PortableResidentLifecycle.prototype,original=proto.request;
 proto.request=async function(method,...args){const result=await original.call(this,method,...args);if(method==='config/read')await editPromptFixture(path,'UPDATE codex_turn_queue SET owner_user_id=77');return result;};
 try{
  await assert.rejects(new ServerRequestDelivery(path,server,{sendValidated:async()=>{throw new Error('must not send');}}).process(1n,request),/original authority changed/);
  assert.deepEqual(await callPromptFixture(server,'answers'),[]);
 }finally{proto.request=original;}
},{enableResponses:true,method:'mcpServer/elicitation/request',params:chromeAccess,configResponse:savedChromeConfig}));

for(const connector_id of ['computer-use','browser'])test('allow policy answers high-risk '+connector_id+' without saved app or prompt',async()=>promptFixture(async(path,server,request)=>{
 let sends=0;const worker=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 110n;}},false,undefined,undefined,'allow');
 await worker.process(1n,request);assert.equal(sends,0);assert.equal(server.pendingServerRequests().length,0);
 assert.deepEqual((await callPromptFixture(server,'answers') as Array<{result:unknown}>).map(x=>x.result),[{action:'accept',content:{},_meta:null}]);
 await assert.rejects(worker.process(1n,request));assert.equal((await callPromptFixture(server,'answers') as unknown[]).length,1);
},{enableResponses:true,method:'mcpServer/elicitation/request',params:{...chromeAccess,_meta:{codex_approval_kind:'mcp_tool_call',connector_id,riskLevel:'high',tool_params:{app:'New app'}}}}));

for(const bad of ['unowned','wrong-generation','remapped','expired','finished'] as const)test('allow policy still rejects '+bad,async()=>promptFixture(async(path,server,request)=>{
 if(bad==='unowned')await editPromptFixture(path,'UPDATE codex_turn_queue SET owner_user_id=NULL');
 if(bad==='wrong-generation')await editPromptFixture(path,'UPDATE codex_turn_queue SET app_server_generation=999');
 if(bad==='remapped')await editPromptFixture(path,"UPDATE mirror_threads SET codex_thread_id='other'");
 if(bad==='finished')await callPromptFixture(server,'finish');
 const supplied=bad==='expired'?{...request,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16).fill(99))}:request;
 await assert.rejects(new ServerRequestDelivery(path,server,{sendValidated:async()=>{throw new Error('must not send');}},false,undefined,undefined,'allow').process(1n,supplied));
 assert.deepEqual(await callPromptFixture(server,'answers'),[]);
},{enableResponses:true,method:'mcpServer/elicitation/request',params:chromeAccess}));
