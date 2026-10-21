import test from 'node:test';
import assert from 'node:assert/strict';
import {ServerRequestDelivery} from '../../src/runtime/server-request-delivery.ts';
import {handlePendingTextReply,pendingTextReplyAvailable} from '../../src/runtime/component-worker/text-reply.ts';
import {promptTextFingerprint} from '../../src/runtime/server-prompt-text-binding.ts';
import {buildServerPrompt} from '../../src/runtime/server-prompt.ts';
import {promptFixture,callPromptFixture} from '../helpers/server-prompt-fixture.ts';
const params={threadId:'t',turnId:'v',serverName:'fixture-mcp',message:'Choose the destination and copies',
 requestedSchema:{type:'object',properties:{folder:{type:'string',minLength:2},copies:{type:'integer',minimum:1}},required:['folder','copies'],additionalProperties:false}};
for(const mode of ['form','openai/form',undefined])for(const policy of ['ask','allow'] as const)test('MCP input stays pending then submits exact typed answer '+String(mode)+'/'+policy,async()=>promptFixture(async(path,server,request)=>{
 const bodies:string[]=[],transport={sendValidated:async(r:{body:string})=>{bodies.push(r.body);return 301n;}};
 const worker=new ServerRequestDelivery(path,server,transport,false,undefined,undefined,'allow',policy);
 await worker.process(1n,request);
 assert.equal(server.pendingServerRequests().length,1,'F1: automatic cancellation is forbidden');
 assert.deepEqual(await callPromptFixture(server,'answers'),[]);
 assert.equal(bodies.length,1);
 const text=JSON.parse(bodies[0]!).content as string;
 for(const expected of ['fixture-mcp','destination','folder','copies','required','/cancel','/decline'])assert.ok(text.includes(expected),expected);
 await worker.process(1n,request);await new ServerRequestDelivery(path,server,transport).recover();
 assert.equal(bodies.length,1,'recovery must reuse the original receipt');
 assert.equal(pendingTextReplyAvailable('t',server),true);
 const prefix='[codex-reply:'+promptTextFingerprint(request,1n)+'] ';
 await assert.rejects(handlePendingTextReply('t',prefix+'{"folder":"C:/work","copies":2}',server,path,1n,9n));
 await assert.rejects(handlePendingTextReply('t','[codex-reply:'+promptTextFingerprint(request,2n)+'] {}',server,path,1n,2n));
 await assert.rejects(handlePendingTextReply('t',prefix+'{"folder":"C:/work","copies":0}',server,path,1n,2n));
 assert.deepEqual(await callPromptFixture(server,'answers'),[]);assert.equal(server.pendingServerRequests().length,1);
 assert.match((await handlePendingTextReply('t',prefix+'{"folder":"C:/work","copies":2}',server,path,1n,2n))!,/submitted/);
 assert.deepEqual((await callPromptFixture(server,'answers') as Array<{result:unknown}>).map(x=>x.result),[{action:'accept',content:{folder:'C:/work',copies:2n},_meta:null}]);
 assert.equal(server.pendingServerRequests().length,0);
 await assert.rejects(handlePendingTextReply('t',prefix+'{}',server,path,1n,2n));
 assert.equal((await callPromptFixture(server,'answers') as unknown[]).length,1);
},{enableResponses:true,method:'mcpServer/elicitation/request',params:{...params,...(mode===undefined?{}:{mode})}}));

test('malformed MCP schema produces an actionable pending prompt without sending cancel',async()=>promptFixture(async(path,server,request)=>{
 const bodies:string[]=[];
 await new ServerRequestDelivery(path,server,{sendValidated:async(r:{body:string})=>{bodies.push(r.body);return 302n;}}).process(1n,request);
 assert.equal(server.pendingServerRequests().length,1);assert.deepEqual(await callPromptFixture(server,'answers'),[]);
 assert.ok(bodies.length>0);assert.match(buildServerPrompt(request,1n).text,/pending/i);
 await assert.rejects(handlePendingTextReply('t','{"x":"a"}',server,path,1n,2n));
 assert.deepEqual(await callPromptFixture(server,'answers'),[]);
},{enableResponses:true,method:'mcpServer/elicitation/request',params:{...params,mode:'form',requestedSchema:{type:'object',properties:{x:{type:'not-a-type'}}}}}));
