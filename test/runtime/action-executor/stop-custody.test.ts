import assert from 'node:assert/strict';import {it} from 'node:test';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {StopActionExecutor} from '../../../src/runtime/action-executor/stop-action.ts';import {AdmittedStopExecutor} from '../../../src/runtime/action-executor/stop-custody.ts';import {BridgeState} from '../../../src/runtime/bridge-state.ts';import {TargetLocks} from '../../../src/core/keyed-locks.ts';
const actor={channelId:42n,userId:3n,discordMessageId:5n};
async function fixture(run:(f:{path:string;bridge:BridgeState;locks:TargetLocks;action:AdmittedStopExecutor;holds:()=>Promise<bigint>})=>Promise<void>){await storeFixture(async path=>{
 const bridge=new BridgeState(join(dirname(path),'bridge.json'));bridge.setSelectedThreadId('T');const locks=new TargetLocks(),stop=new StopActionExecutor(path,null,bridge,locks,e=>e instanceof Error?e.message:'fixture');
 await state.admitIngress(path,{ingressId:'message:5',kind:'message',eventId:5n,applicationId:null,channelId:42n,ownerUserId:3n,sourceMessageId:5n,targetThreadId:'T',canonicalOwner:null,now:1,payload:{version:1n,content:'!stop',plan:{Execute:{Stop:{reference:null}}},lifecycle_binding:{target:'T',route:'Selected',command:{Stop:{reference:null}}},stop_origin:{target:'T',stopRevision:0n}}});
 const db=await openInitialized(path);try{db.exec("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id='message:5';INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('j','T',42,3,1,'p',0,1,'pending',0,'[]',1,1)");}finally{db.close();}
 const holds=async()=>{const d=await openInitialized(path);try{const s=d.prepare('SELECT count(*) AS n FROM cdr_execution_holds');s.setReadBigInts(true);return s.get()!.n as bigint;}finally{d.close();}};
 await run({path,bridge,locks,action:new AdmittedStopExecutor(path,bridge,stop),holds});
});}
it('original admitted Stop preserves durable local receipt without waiting for busy target or resident',async()=>fixture(async f=>{
 const lease=await f.locks.acquire('T');try{const result=await f.action.execute(actor,null,'message:5');assert.match(result.text,/Stop accepted for T/);assert.match(result.text,/Execution end is not confirmed/);assert.equal(await f.holds(),1n);lease.requireTarget('T');assert.equal((await state.listQueueJobs(f.path))[0]!.state,'Pending');}finally{lease.release();}
}));
it('wrong actor, original event or changed selected target cannot write a local stop receipt',async()=>fixture(async f=>{
 await assert.rejects(f.action.execute({...actor,userId:4n},null,'message:5'),/envelope differs/);await assert.rejects(f.action.execute({...actor,discordMessageId:6n},null,'message:5'),/envelope differs/);f.bridge.setSelectedThreadId('other');await assert.rejects(f.action.execute(actor,null,'message:5'),/target changed/);assert.equal(await f.holds(),0n);assert.equal(f.locks.activeTargetCount,0);
}));
it('pre-cancel preserves ingress and queue without accepting stop or taking shared control',async()=>fixture(async f=>{
 const before=await state.getIngress(f.path,'message:5'),c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(f.action.execute(actor,null,'message:5',c.signal),e=>e===reason);assert.deepEqual(await state.getIngress(f.path,'message:5'),before);assert.equal(await f.holds(),0n);assert.equal(f.locks.activeTargetCount,0);
}));
