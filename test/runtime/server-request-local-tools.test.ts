import {localToolPolicyResponse} from '../../src/runtime/server-request-local-tools.ts';
import {isObservationalRequest} from '../../src/app-server/requests.ts';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import {localToolFormResponse} from '../../src/runtime/server-request-local-tools.ts';
const params=()=>({mode:'form',serverName:'node_repl',_meta:{codex_approval_kind:'mcp_tool_call',connector_id:'computer-use',riskLevel:'low'},requestedSchema:{type:'object',properties:{}}});
function decide(p:unknown,method='mcpServer/elicitation/request'){return localToolFormResponse({id:1n,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16)),method,params:p});}
test('both exact modes and connectors accept only an empty approval schema',()=>{
 for(const mode of ['form','openai/form'])for(const connector of ['computer-use','browser']){
  const p=params();p.mode=mode;p._meta.connector_id=connector;
  assert.deepEqual(decide(p),{response:{action:'accept',content:{},_meta:null},disposition:'local-tool-access-auto-accepted'});
  for(const additionalProperties of [true,false])assert.equal(decide({...p,requestedSchema:{...p.requestedSchema,required:[],additionalProperties}})?.response.action,'accept');
 }
});
test('other methods and URL or missing modes retain existing handling',()=>{
 for(const p of [null,{},[],{mode:'url'},{mode:'FORM'},{mode:1}])assert.equal(decide(p),null);
 assert.equal(decide(params(),'item/commandExecution/requestApproval'),null);
});
test('unknown server, connector, unknown risk and malformed metadata cancel',()=>{
 for(const change of [{serverName:'other'},{_meta:null},{_meta:{}},{_meta:{...params()._meta,connector_id:'filesystem'}},{_meta:{...params()._meta,riskLevel:'unknown'}},{_meta:{...params()._meta,codex_approval_kind:'other'}}]){
  assert.deepEqual(decide({...params(),...change}),{response:{action:'cancel',content:null,_meta:null},disposition:'unsupported-form-cancelled'});
 }
});
test('schema ambiguity, data entry, null optionals and unknown validation keywords cancel',()=>{
 for(const schema of [null,[],{}, {type:'array',properties:{}},{type:'object',properties:[]},{type:'object',properties:{name:{type:'string'}}},
 {type:'object',properties:{},required:null},{type:'object',properties:{},required:['name']},
 {type:'object',properties:{},additionalProperties:null},{type:'object',properties:{},additionalProperties:{}},
 {type:'object',properties:{},title:'approval'},{type:'object',properties:{},allOf:[]}]){
  assert.equal(decide({...params(),requestedSchema:schema})?.response.action,'cancel');
 }
});
test('no getter or proxy traps run and input remains untouched',()=>{
 let calls=0;const p=params();Object.defineProperty(p,'requestedSchema',{get(){calls++;return {};}});
 assert.throws(()=>decide(p),TypeError);assert.equal(calls,0);
 const proxy=new Proxy(params(),{ownKeys(){calls++;return [];}});
 assert.throws(()=>decide(proxy),TypeError);assert.equal(calls,0);
 const normal=params(),before=JSON.stringify(normal),result=decide(normal)!;
 assert.equal(JSON.stringify(normal),before);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.response));assert.ok(Object.isFrozen(result.response.content));
});

test('recognized high-risk access stays pending instead of automatic cancellation',()=>{
 for(const connector_id of ['computer-use','browser'])for(const mode of ['form','openai/form']) {
  const p=params();p.mode=mode;p._meta.connector_id=connector_id;p._meta.riskLevel='high';
  assert.equal(decide(p),null,'recognized access must reach saved-grant or owner-approval handling');
 }
});

test('saved app grants require exact user config and native persistence support',()=>{
 const p={...params(),_meta:{...params()._meta,riskLevel:'high',persist:['session','always'],tool_params:{app:'Chrome'}}};
 const request={id:1n,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16)),method:'mcpServer/elicitation/request',params:p};
 const user={name:{type:'user'},config:{computer_use:{windows:{always_allowed_app_ids:['Chrome']}}}};
 const config={layers:[user]};
 assert.equal(isObservationalRequest('config/read'),true);
 assert.equal(localToolFormResponse(request,config)?.disposition,'saved-app-access-auto-accepted');
 for(const invalid of [{},{layers:[]},{layers:[user,user]},
  {layers:[{...user,name:{type:'project'}}]}, {layers:[{...user,disabledReason:'untrusted'}]},
  ...[[],['Other'],['Chrome',1]].map(ids=>({layers:[{...user,config:{computer_use:{windows:{always_allowed_app_ids:ids}}}}]})),
  {layers:[{...user,config:{computer_use:{allow_persistent_approval:false,windows:{always_allowed_app_ids:['Chrome']}}}}]}]){
   assert.equal(localToolFormResponse(request,invalid),null);
 }
 for(const patch of [{persist:['session']},{tool_params:{app:'Other'}},{tool_params:{app:'computer-audio'}},
  {tool_params:{app:'Chrome',command:'other'}},{connector_id:'browser'},{tool_name:'other'},{codex_request_type:'other'}]){
  assert.equal(localToolFormResponse({...request,params:{...p,_meta:{...p._meta,...patch}}},config),null);
 }
 assert.equal(localToolFormResponse({...request,params:{...p,requestedSchema:{type:'object',properties:{secret:{type:'string'}}}}},config)?.response.action,'cancel');
 // A later config read without the grant immediately removes automatic access.
 assert.equal(localToolFormResponse(request,{layers:[{...user,config:{computer_use:{windows:{always_allowed_app_ids:[]}}}}]}),null);
});

test('allow policy covers all known local approval forms without a persistent grant',()=>{
 for(const connector_id of ['computer-use','browser'])for(const riskLevel of ['low','high'])for(const mode of ['form','openai/form']){
  const p={...params(),mode,_meta:{...params()._meta,connector_id,riskLevel,persist:['session']}};
  const request={id:1n,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16)),method:'mcpServer/elicitation/request',params:p};
  assert.deepEqual(localToolPolicyResponse(request,'allow'),{response:{action:'accept',content:{},_meta:null},disposition:'local-tool-policy-auto-accepted'});
  assert.equal(localToolPolicyResponse(request,'ask'),null);
 }
});

test('allow policy leaves unknown forms and other request protocols alone',()=>{
 const request={id:1n,occurrence:ServerRequestOccurrence.fromBytes(new Uint8Array(16)),method:'mcpServer/elicitation/request',params:params()};
 for(const patch of [{serverName:'other'},{mode:'url'},{_meta:{...params()._meta,connector_id:'other'}},{_meta:{...params()._meta,riskLevel:'unknown'}},{_meta:{...params()._meta,codex_approval_kind:'other'}},{requestedSchema:{type:'object',properties:{name:{type:'string'}}}}])assert.equal(localToolPolicyResponse({...request,params:{...params(),...patch}},'allow'),null);
 for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','item/tool/requestUserInput'])assert.equal(localToolPolicyResponse({...request,method},'allow'),null);
});
