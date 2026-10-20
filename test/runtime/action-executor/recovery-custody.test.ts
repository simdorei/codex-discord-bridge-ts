import assert from 'node:assert/strict';import {it} from 'node:test';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {claimAdmittedRecovery} from '../../../src/runtime/action-executor/recovery-custody.ts';import {BridgeState} from '../../../src/runtime/bridge-state.ts';import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';import {AppServerInvalidReplyError} from '../../../src/app-server/client-errors.ts';import {createRuntimeFenceErrors} from '../../../src/runtime/fence-errors.ts';
import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';
const actor={channelId:1n,userId:2n,discordMessageId:3n},render=(e:unknown)=>e instanceof Error?e.message:'fixture error';
async function fixture(kind:'Recover'|'Repair',route:'Selected'|'Explicit'|'Mapped',run:(f:{path:string;bridge:BridgeState;claim:()=>ReturnType<typeof claimAdmittedRecovery>;sql:(text:string)=>Promise<void>})=>Promise<void>){await storeFixture(async path=>{
 const bridge=new BridgeState(join(dirname(path),'bridge.json'));bridge.setSelectedThreadId('target');const reference=route==='Explicit'?'target':null,command={[kind]:{reference}};
 await state.admitIngress(path,{ingressId:'message:3',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,targetThreadId:'target',canonicalOwner:null,now:1,payload:{version:1n,plan:{Execute:command},lifecycle_binding:{target:'target',route,command}}});
 const sql=async(text:string)=>{const db=await openInitialized(path);try{db.exec(text);}finally{db.close();}};
 await sql("UPDATE discord_ingress_journal SET state='executing',phase='processing'");
 if(route==='Mapped')await sql("INSERT INTO mirror_threads VALUES('target','p','title',10,1,1)");
 await run({path,bridge,sql,claim:()=>claimAdmittedRecovery(path,bridge,actor,kind,reference,'message:3',render)});
});}
it('original Recover and Repair custody is claimed once and never reconstructed as a retry',async()=>{
 for(const kind of ['Recover','Repair'] as const)await fixture(kind,'Explicit',async f=>{const guard=await f.claim();assert.equal(guard.target,'target');guard.check();assert.equal((await state.getIngress(f.path,'message:3'))!.phase,'recovery_claimed');await assert.rejects(f.claim(),/envelope differs/);guard.check();});
});
it('wrong original actor, command and missing binding preserve unclaimed ingress',async()=>fixture('Recover','Selected',async f=>{
 await assert.rejects(claimAdmittedRecovery(f.path,f.bridge,{...actor,userId:9n},'Recover',null,'message:3',render),/envelope differs/);
 await assert.rejects(claimAdmittedRecovery(f.path,f.bridge,actor,'Repair',null,'message:3',render),/envelope differs/);
 await f.sql("UPDATE discord_ingress_journal SET payload_json=json_remove(payload_json,'$.lifecycle_binding')");await assert.rejects(f.claim(),/not frozen/);assert.equal((await state.getIngress(f.path,'message:3'))!.phase,'processing');
}));
it('Selected and Mapped changes are checked again after one-use claim with no replacement',async()=>{
 await fixture('Recover','Selected',async f=>{const guard=await f.claim();f.bridge.setSelectedThreadId('other');assert.throws(()=>guard.check(),/target changed/);assert.equal((await state.getIngress(f.path,'message:3'))!.phase,'recovery_claimed');});
 await fixture('Recover','Mapped',async f=>{const guard=await f.claim();await f.sql("UPDATE mirror_threads SET codex_thread_id='other'");assert.throws(()=>guard.check(),/no retarget or replay/);});
});
it('Repair archive fence blocks both initial claim and later effect checks',async()=>{
 await fixture('Repair','Explicit',async f=>{await f.sql("INSERT INTO codex_archive_fences VALUES('target','archive',NULL,'attempted')");await assert.rejects(f.claim(),/original archive intent is preserved/);assert.equal((await state.getIngress(f.path,'message:3'))!.phase,'processing');});
 await fixture('Repair','Explicit',async f=>{const guard=await f.claim();await f.sql("INSERT INTO codex_archive_fences VALUES('target','archive',NULL,'verified')");assert.throws(()=>guard.check(),/no tool reset was authorized/);});
});
it('Recover does not borrow the Repair-only archive exception as permission to clear a fence',async()=>fixture('Recover','Explicit',async f=>{
 await f.sql("INSERT INTO codex_archive_fences VALUES('target','archive',NULL,'attempted')");const guard=await f.claim();guard.check();assert.equal(await state.archiveTargetFenced(f.path,'target'),true);
}));
it('borrowed cancellation transaction observes uncommitted custody change and remains caller owned',async()=>fixture('Recover','Explicit',async f=>{
 const guard=await f.claim(),db=await openInitialized(f.path);try{db.exec('BEGIN IMMEDIATE');assert.equal(guard.checkIn(db),undefined);db.exec("UPDATE discord_ingress_journal SET phase='changed'");assert.throws(()=>guard.checkIn(db),/no retarget or replay/);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');guard.checkIn(db);}finally{db.close();}guard.check();
}));
it('pre-cancel acquires no claim; changed claim is refused by checked resident dispatch before native read',async()=>fixture('Repair','Explicit',async f=>{
 const c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(claimAdmittedRecovery(f.path,f.bridge,actor,'Repair','target','message:3',render,c.signal),e=>e===reason);assert.equal((await state.getIngress(f.path,'message:3'))!.phase,'processing');
 const guard=await f.claim(),proof=guard.rpcCheck();assert.equal(proof.rejected(),false);
 const code="import readline from 'node:readline';let seen=0;readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.method==='initialized')return;if(m.method==='thread/read')seen++;process.stdout.write(JSON.stringify({id:m.id,result:m.method==='seen'?seen:{}})+'\\n');});";
 await f.sql("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");
 const server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'guard',title:'fixture',version:'1'}},render,{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:render,fence:createMutationCustodyFence(f.path,'runtime',render)});
 try{
  await f.sql("UPDATE discord_ingress_journal SET owner_user_id=99");
  await assert.rejects(server.requestForToolRepairChecked('thread/read',{threadId:'target',includeTurns:false},1000,server.generation(),proof.check),AppServerInvalidReplyError);
  assert.equal(proof.rejected(),true);const a=server.admitResponse(server.generation());try{assert.equal(await a.client.requestAdmitted(a.permit,'seen',{},1000),0n);}finally{a.release();}
 }finally{await server.dispose();}
}));
it('central InvalidReply mapper refuses non-text or asynchronous diagnostic renderers',()=>{
 assert.throws(()=>createRuntimeFenceErrors((async()=> 'bad') as unknown as (e:unknown)=>string),/synchronous/);
 const errors=createRuntimeFenceErrors((()=>Promise.resolve('bad')) as unknown as (e:unknown)=>string);assert.throws(()=>errors.fail('InvalidReply',new Error('raw')),/public-safe/);
 const good=createRuntimeFenceErrors(()=> 'safe');assert.throws(()=>good.fail('InvalidReply',Object.create(null)),e=>e instanceof AppServerInvalidReplyError&&e.message==='invalid app-server reply: safe');
});
