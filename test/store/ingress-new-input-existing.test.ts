import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {recordNewInput,recordNewInputExisting,newExecutionPrompt} from '../../src/store/ingress-new-input.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const key='message:9007199254740993',raw='raw 원문',prompt='prepared 📎\nabc';
const input=()=>({ingressId:key,kind:'message' as const,eventId:9007199254740993n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:9007199254740993n,payload:{version:1n,content:'!new '+raw,plan:{Execute:{New:{prompt:raw}}},attachments:[{id:10n,filename:'a.txt',size:3n}]},targetThreadId:null,canonicalOwner:null,now:1});
function edit(path:string,sql:string){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
async function admit(path:string,begin=true){await state.admitIngress(path,input());if(begin)await state.beginIngressExecution(path,key,'processing',null,2);}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
test('existing New input never creates or repairs a missing or incompatible store',()=>storeFixture(async path=>{
 assert.throws(()=>recordNewInputExisting(path,key,raw,prompt,3));assert.equal(existsSync(path),false);edit(path,'CREATE TABLE sentinel(value)');assert.throws(()=>recordNewInputExisting(path,key,raw,prompt,3));
 const db=new DatabaseSync(path);try{assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(x=>x.name),['sentinel']);}finally{db.close();}
}));
test('both New input entrypoints share exact hashes, raw plan and equal-idempotence after thread/start',async t=>{
 for(const write of [recordNewInput,recordNewInputExisting])await storeFixture(async path=>{
  await admit(path);const original=(await state.getIngress(path,key))!;await write(path,key,raw,prompt,3);const prepared=(await state.getIngress(path,key))!;
  assert.deepEqual(prepared.payload,original.payload);assert.deepEqual(prepared.outcome,{new_input:{version:1n,source_sha256:digest(serializeSerdeValue([original.ingressId,original.kind,original.eventId,original.channelId,original.ownerUserId,original.payload])),prompt_sha256:digest(prompt),prompt}});assert.equal(newExecutionPrompt(prepared),prompt);
  assert.equal(await state.beginIngressThreadStart(path,key,7n,4),true);const before=await state.getIngress(path,key),transactions:string[]=[],exec=DatabaseSync.prototype.exec;
  const mock=t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){if(['BEGIN IMMEDIATE','ROLLBACK','COMMIT'].includes(sql))transactions.push(sql);return exec.call(this,sql);});
  try{await write(path,key,raw,prompt,999);assert.deepEqual(transactions,['BEGIN IMMEDIATE','ROLLBACK']);}finally{mock.mock.restore();}
  assert.deepEqual(await state.getIngress(path,key),before);
 });
});
test('New input rejects changed prepared prompt, original raw prompt, and source envelope without overwriting evidence',()=>storeFixture(async path=>{
 await admit(path);recordNewInputExisting(path,key,raw,prompt,3);const before=await state.getIngress(path,key);
 assert.throws(()=>recordNewInputExisting(path,key,raw,prompt+'changed',4),/immutable/);assert.throws(()=>recordNewInputExisting(path,key,raw+'changed',prompt,4),/original prompt/);assert.deepEqual(await state.getIngress(path,key),before);
 edit(path,"UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.attachments[0].filename','changed.txt')");assert.throws(()=>recordNewInputExisting(path,key,raw,prompt,4),/immutable/);await assert.rejects(state.beginIngressThreadStart(path,key,7n,5),/original envelope changed/);
}));
test('New input requires original attachments and executing processing before first write',async()=>{
 for(const sql of [null,"UPDATE discord_ingress_journal SET state='executing',phase='thread/start'","UPDATE discord_ingress_journal SET state='held',phase='processing'","UPDATE discord_ingress_journal SET state='executing',phase='processing',payload_json=json_set(payload_json,'$.attachments',json('[]'))"]){await storeFixture(async path=>{
  await admit(path,false);if(sql!==null)edit(path,sql);const before=await state.getIngress(path,key);assert.throws(()=>recordNewInputExisting(path,key,raw,prompt,3));assert.deepEqual(await state.getIngress(path,key),before);
 });}
});
test('New input validates passive primitive arguments before opening store and rolls back failed update',()=>storeFixture(async path=>{
 let hooks=0;const active={toString(){hooks++;return raw;}};for(const [r,p,n] of [[active,prompt,3],[raw,'\ud800',3],[raw,'\u0085',3],[raw,prompt,Infinity]] as const)assert.throws(()=>recordNewInputExisting(path,key,r as string,p,n));assert.equal(hooks,0);assert.equal(existsSync(path),false);
 await admit(path);const before=await state.getIngress(path,key);edit(path,"CREATE TRIGGER reject_new_input BEFORE UPDATE OF outcome_json ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture'); END");assert.throws(()=>recordNewInputExisting(path,key,raw,prompt,3),/fixture/);assert.deepEqual(await state.getIngress(path,key),before);
}));
