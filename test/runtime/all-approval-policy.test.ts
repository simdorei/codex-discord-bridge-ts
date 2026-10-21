import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalPolicyResponse} from '../../src/runtime/server-request-approval-policy.ts';
import {loadRuntimeConfig} from '../../src/config/runtime.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import {ServerRequestDelivery} from '../../src/runtime/server-request-delivery.ts';
import {promptFixture,callPromptFixture,editPromptFixture} from '../helpers/server-prompt-fixture.ts';

const permissions={network:{enabled:true},fileSystem:{write:['C:/fixture']}};
const base={threadId:'t',turnId:'v',permissions};
const accepted={action:'accept',content:{},_meta:null};
const cases:Array<{method:string;params:unknown;response:unknown}>=[
 {method:'item/commandExecution/requestApproval',params:base,response:{decision:'accept'}},
 {method:'item/fileChange/requestApproval',params:base,response:{decision:'accept'}},
 {method:'execCommandApproval',params:base,response:{decision:'approved'}},
 {method:'applyPatchApproval',params:base,response:{decision:'approved'}},
 {method:'item/permissions/requestApproval',params:base,response:{permissions,scope:'turn'}},
 ...['form','openai/form','url'].map(mode=>({method:'mcpServer/elicitation/request',params:{...base,mode,serverName:'codex_apps',url:'https://example.com/approval',_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'github',riskLevel:'high',tool_name:'github_create_tree'},requestedSchema:{type:'object',properties:{}}},response:accepted})),
 {method:'mcpServer/elicitation/request',params:{...base,mode:'form',serverName:'another-mcp',requestedSchema:{type:'object',properties:{}}},response:accepted},
];
test('all approval policy uses the literal accept response for every approval protocol',()=>{
 for(const c of cases){
  const request={...c,id:'approval',occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16))};
  assert.deepEqual(approvalPolicyResponse(request,'allow')?.response,c.response,c.method);
  assert.equal(approvalPolicyResponse(request,'ask'),null);
 }
});
test('all approval policy does not invent answers',()=>{
 const request={id:'approval',occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16)),method:'mcpServer/elicitation/request',params:{...base,mode:'form',requestedSchema:{type:'object',properties:{answer:{type:'string'}},required:['answer']}}};
 assert.equal(approvalPolicyResponse(request,'allow'),null);
 for(const method of ['item/tool/requestUserInput','item/tool/call','future/request'])assert.equal(approvalPolicyResponse({...request,method},'allow'),null);
});
test('all approval setting defaults to ask and validates explicit allow',()=>{
 const env=new Map([['DISCORD_BOT_TOKEN','fixture'],['DISCORD_ALLOW_ALL_CHANNELS','1']]);
 assert.equal(loadRuntimeConfig(env).approvalPolicy,'ask');
 for(const [raw,expected] of [['','ask'],['ask','ask'],['allow','allow'],[' allow ','allow']]){
  env.set('DISCORD_APPROVAL_POLICY',raw!);assert.equal(loadRuntimeConfig(env).approvalPolicy,expected);
 }
 env.set('DISCORD_APPROVAL_POLICY','ALLOW');assert.throws(()=>loadRuntimeConfig(env),/DISCORD_APPROVAL_POLICY must be ask or allow/);
});
for(const [index,c] of cases.entries())test('all approval policy answers the actual resident once without HTTP: '+index,async()=>promptFixture(async(path,server,request)=>{
 let sends=0;
 const worker=new ServerRequestDelivery(path,server,{sendValidated:async()=>{sends++;return 110n;}},false,undefined,undefined,'ask','allow');
 await worker.process(1n,request);
 assert.equal(sends,0);assert.equal(server.pendingServerRequests().length,0);
 assert.deepEqual((await callPromptFixture(server,'answers') as Array<{result:unknown}>).map(x=>x.result),[c.response]);
 await assert.rejects(worker.process(1n,request));
 assert.equal((await callPromptFixture(server,'answers') as unknown[]).length,1);
},{enableResponses:true,method:c.method,params:c.params}));
for(const bad of ['unowned','wrong-generation','finished'])test('all approval policy retains authority: '+bad,async()=>promptFixture(async(path,server,request)=>{
 if(bad==='unowned')await editPromptFixture(path,'UPDATE codex_turn_queue SET owner_user_id=NULL');
 if(bad==='wrong-generation')await editPromptFixture(path,'UPDATE codex_turn_queue SET app_server_generation=999');
 if(bad==='finished')await callPromptFixture(server,'finish');
 await assert.rejects(new ServerRequestDelivery(path,server,{sendValidated:async()=>{throw new Error('must not send');}},false,undefined,undefined,'ask','allow').process(1n,request));
 assert.deepEqual(await callPromptFixture(server,'answers'),[]);
},{enableResponses:true,method:cases[5]!.method,params:cases[5]!.params}));
