import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {MessageCustody} from '../../../src/runtime/message-worker/custody.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
const key='message:3',reason='message processing ended before a durable handoff or confirmed response';
async function staged(path:string){await state.admitIngress(path,{ingressId:key,kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n,content:'!help',plan:{Execute:'Help'},processing_mode:'normal'},targetThreadId:null,canonicalOwner:null,now:1});}
function fixture(run:(path:string,log:unknown[])=>Promise<void>){return storeFixture(async path=>{await staged(path);await run(path,[]);});}
const owner=(path:string,log:unknown[],now=()=>2)=>new MessageCustody(path,key,{now,report:v=>{log.push(v);}});
function edit<T>(path:string,run:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
const notices=(path:string)=>edit(path,db=>db.prepare('SELECT content FROM codex_delivery_outbox').all().map(r=>String(r.content)));
test('unbegun message disposal records one explicit not-executed hold and is idempotent',()=>fixture(async(path,log)=>{
 const c=owner(path,log);const first=c.dispose();assert.equal(c.dispose(),first);await first;const row=(await state.getIngress(path,key))!;
 assert.equal(row.state,'held');assert.equal(row.holdReason,reason);assert.equal(row.confirmationDelivered,false);assert.equal(notices(path).length,1);assert.match(notices(path)[0]!,/saved but was not executed/);assert.deepEqual(log,[]);assert.throws(()=>c.begin(null),/closed/);
}));
test('begun cancellation retains unknown outcome with original processing phase',()=>fixture(async(path,log)=>{
 const c=owner(path,log);await c.begin('target');await c.dispose();const row=(await state.getIngress(path,key))!;
 assert.equal(row.state,'held');assert.equal(row.phase,'processing');assert.equal(row.targetThreadId,'target');assert.match(notices(path)[0]!,/execution outcome is unknown/);assert.deepEqual(log,[]);
}));
test('result followed by finish preserves result and suppresses disposal hold',()=>fixture(async(path,log)=>{
 const c=owner(path,log);await c.begin(null);await state.recordIngressResult(path,key,{kind:'help',action_completed:true},3);await c.finish();await c.dispose();
 const row=(await state.getIngress(path,key))!;assert.equal(row.confirmationDelivered,true);assert.deepEqual(row.outcome,{kind:'help',action_completed:true});assert.deepEqual(notices(path),[]);assert.deepEqual(log,[]);
}));
test('recorded result without finish produces known completion notice, never replay authority',()=>fixture(async(path,log)=>{
 const c=owner(path,log);await c.begin(null);await state.recordIngressResult(path,key,{action_completed:true},3);await c.dispose();
 assert.match(notices(path)[0]!,/action completed/);assert.deepEqual((await state.getIngress(path,key))!.outcome,{action_completed:true});assert.equal((await state.getIngress(path,key))!.confirmationDelivered,false);
}));
test('dispose joins the claimed begin operation before choosing uncertainty',()=>fixture(async(path,log)=>{
 const c=owner(path,log);const begun=c.begin(null),disposed=c.dispose();await Promise.all([begun,disposed]);assert.match(notices(path)[0]!,/execution outcome is unknown/);assert.deepEqual(log,[]);
}));
test('dispose joins finish before deciding no hold is needed',()=>fixture(async(path,log)=>{
 const c=owner(path,log);await c.begin(null);await state.recordIngressResult(path,key,{action_completed:true},3);const finish=c.finish();const disposed=c.dispose();await Promise.all([finish,disposed]);assert.deepEqual(notices(path),[]);assert.equal((await state.getIngress(path,key))!.confirmationDelivered,true);
}));
test('concurrent state transitions fail synchronously instead of racing borrowed custody',()=>fixture(async(path,log)=>{
 const c=owner(path,log),begin=c.begin(null);assert.throws(()=>c.finish(),/already borrowed/);assert.throws(()=>c.begin(null),/already borrowed/);await begin;await c.dispose();
}));
test('failed begin does not claim started and cleanup retains not-executed classification',()=>fixture(async(path,log)=>{
 const c=owner(path,log);await state.holdIngress(path,key,'existing',true,2);await assert.rejects(c.begin(null),/no longer executable/);await c.dispose();assert.match(notices(path)[0]!,/was not executed/);assert.deepEqual(log,[]);
}));
test('clock and hold failures are reported with only source request identity; row remains saved',()=>fixture(async(path,log)=>{
 const c=owner(path,log,()=>NaN);await c.dispose();assert.equal(log.length,1);assert.equal((log[0] as any).code,'message_custody_hold_error');assert.equal((log[0] as any).requestId,key);assert.equal((await state.getIngress(path,key))!.state,'staged');
 const c2=owner(path,log);edit(path,db=>db.exec("CREATE TRIGGER fail_hold BEFORE UPDATE ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture hold failed'); END"));await c2.dispose();assert.equal(log.length,2);assert.equal((await state.getIngress(path,key))!.state,'staged');
}));
test('callback boundary rejects getters, proxies, async callbacks and null clocks without running hooks',()=>{
 let hooks=0;const options:any={report:()=>{}};Object.defineProperty(options,'now',{get(){hooks++;return ()=>1;}});assert.throws(()=>new MessageCustody('/unused',key,options),TypeError);
 for(const now of [null,async()=>1,new Proxy(()=>1,{apply(){hooks++;return 1;}})])assert.throws(()=>new MessageCustody('/unused',key,{now:now as any,report:()=>{}}),TypeError);
 assert.throws(()=>new MessageCustody('/unused',key,{report:async()=>{}}),TypeError);assert.equal(hooks,0);
});
