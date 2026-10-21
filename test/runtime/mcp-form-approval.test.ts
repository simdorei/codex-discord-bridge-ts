import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalPolicyResponse} from '../../src/runtime/server-request-approval-policy.ts';
import {localToolFormResponse} from '../../src/runtime/server-request-local-tools.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import {ServerRequestDelivery} from '../../src/runtime/server-request-delivery.ts';
import {parseComponentId} from '../../src/discord/components.ts';
import {buildComponentResponse} from '../../src/runtime/component-worker/response.ts';
import {verifyPromptAuthority} from '../../src/runtime/server-prompt-authority.ts';
import {promptFixture,callPromptFixture} from '../helpers/server-prompt-fixture.ts';

const accepted={action:'accept',content:{},_meta:null};
const params={threadId:'t',turnId:'v',mode:'form',serverName:'codex_apps',message:'Allow GitHub to publish this commit?',_meta:{connector_id:'github',riskLevel:'high'},requestedSchema:{type:'object',properties:{}}};
test('form annotations preserve empty approval semantics and reject malformed annotation values',()=>{
 for(const key of ['title','description','$schema','$id','$comment']){
  const request={id:'approval',occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16)),method:'mcpServer/elicitation/request',params:{...params,requestedSchema:{...params.requestedSchema,[key]:'annotation'}}};
  assert.deepEqual(approvalPolicyResponse(request,'allow')?.response,accepted,key);
  assert.equal(localToolFormResponse(request),null,'ask must leave the approval pending');
  assert.equal(approvalPolicyResponse({...request,params:{...params,requestedSchema:{...params.requestedSchema,[key]:42}}},'allow'),null);
 }
});

test('annotated allow form is answered once by the actual resident without a prompt',async()=>promptFixture(async(path,server,request)=>{
 const worker=new ServerRequestDelivery(path,server,{sendValidated:async()=>{throw new Error('allow must not prompt');}},false,undefined,undefined,'ask','allow');
 await worker.process(1n,request);
 assert.deepEqual((await callPromptFixture(server,'answers') as Array<{result:unknown}>).map(x=>x.result),[accepted]);
 assert.equal(server.pendingServerRequests().length,0);
 await assert.rejects(worker.process(1n,request));
 assert.equal((await callPromptFixture(server,'answers') as unknown[]).length,1);
},{enableResponses:true,method:'mcpServer/elicitation/request',params:{...params,requestedSchema:{...params.requestedSchema,title:'Approval',description:'Approval only',$schema:'https://json-schema.org/draft/2020-12/schema'}}}));

for(const [mode,buttonIndex,action] of [['form',0,'accept'],['openai/form',2,'decline'],['form',3,'cancel']] as const)test(`ask external ${mode}: bound ${action} leaves the decision to the owner`,async()=>promptFixture(async(path,server,request)=>{
 const bodies:string[]=[];
 const transport={sendValidated:async(r:{body:string})=>{bodies.push(r.body);return 120n;}};
 const worker=new ServerRequestDelivery(path,server,transport);
 await worker.process(1n,request);
 assert.equal(bodies.length,1,'ask must deliver a prompt instead of sending cancel');
 assert.equal(server.pendingServerRequests().length,1);
 assert.deepEqual(await callPromptFixture(server,'answers'),[]);
 await worker.process(1n,request);await new ServerRequestDelivery(path,server,transport).recover();
 assert.equal(bodies.length,1,'durable prompt receipt prevents duplicate delivery');
 const body=JSON.parse(bodies[0]!);assert.match(body.content,/Allow GitHub/);
 const component=parseComponentId(body.components[0].components[buttonIndex].custom_id)!;
 const authority=await verifyPromptAuthority(path,server,request,1n);
 assert.throws(()=>authority.requireActor(authority.channelId,authority.userId+1n));
 authority.requireActor(authority.channelId,authority.userId);
 const response=buildComponentResponse(component,[request],1n);
 assert.throws(()=>buildComponentResponse(component,[request],2n));
 assert.equal(response.occurrence.equals(request.occurrence),true);
 assert.deepEqual(response.payload,{action,content:action==='accept'?{}:null,_meta:null});
 await server.respond(response.requestId,response.occurrence,response.payload,response.generation);
 assert.equal(server.pendingServerRequests().length,0);
 assert.deepEqual((await callPromptFixture(server,'answers') as Array<{result:unknown}>).map(x=>x.result),[response.payload]);
 await assert.rejects(worker.process(1n,request));
},{enableResponses:true,method:'mcpServer/elicitation/request',params:{...params,mode,requestedSchema:{...params.requestedSchema,title:'Approval'}}}));
