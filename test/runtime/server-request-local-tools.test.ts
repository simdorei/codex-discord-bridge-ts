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
test('unknown server, connector, elevated risk and malformed metadata cancel',()=>{
 for(const change of [{serverName:'other'},{_meta:null},{_meta:{}},{_meta:{...params()._meta,connector_id:'filesystem'}},{_meta:{...params()._meta,riskLevel:'high'}},{_meta:{...params()._meta,codex_approval_kind:'other'}}]){
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
