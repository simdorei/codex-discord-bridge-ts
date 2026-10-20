import assert from 'node:assert/strict';import {it} from 'node:test';import {DatabaseSync} from 'node:sqlite';import {join,dirname} from 'node:path';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';import {AdmittedResumeExecutor} from '../../../src/runtime/action-executor/resume-action.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';import {BridgeState} from '../../../src/runtime/bridge-state.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';import {storeFixture} from '../../helpers/store-fixture.ts';
const actor={channelId:1n,userId:2n,discordMessageId:3n};
async function fixture(mode:string,run:(f:{path:string;codex:string;bridge:BridgeState;locks:TargetLocks;server:PortableResidentLifecycle;action:AdmittedResumeExecutor;seen:()=>Promise<any[]>})=>Promise<void>,timeout=3000){await storeFixture(async path=>{
 const codex=join(dirname(path),'codex.sqlite'),bridge=new BridgeState(join(dirname(path),'bridge.json')),locks=new TargetLocks();bridge.setSelectedThreadId('root');
 const cd=new DatabaseSync(codex);try{cd.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES ('root','Root','/tmp',1,0,0),('child','Child','/tmp',1,0,0)");}finally{cd.close();}
 await state.admitIngress(path,{ingressId:'own',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,targetThreadId:'root',canonicalOwner:null,now:1,payload:{version:1n,content:'!resume',plan:{Execute:{Resume:{reference:null}}},lifecycle_binding:{target:'root',route:'Selected',command:{Resume:{reference:null}}},stop_origin:{target:'root',stopRevision:0n}}});
 const db=await openInitialized(path);try{db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime');UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id='own'");}finally{db.close();}
 const code=`import readline from 'node:readline';import {DatabaseSync} from 'node:sqlite';const mode=${JSON.stringify(mode)},file=${JSON.stringify(codex)},seen=[];let lists=0,reads=0;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),reply=result=>emit({id:m.id,result});if(m.method==='initialize')reply({});else if(m.method==='initialized'){}else if(m.method==='seen')reply(seen);else{seen.push({method:m.method,params:m.params});if(m.method==='thread/resume')reply({thread:{id:m.params.threadId}});else if(m.method==='thread/read'){reads++;if(mode!=='stall')reply({thread:{id:mode==='wrong-id'?'foreign':m.params.threadId,status:{type:mode==='unloaded'&&reads===1?'notLoaded':mode==='systemError'?'systemError':mode==='active'?'active':'idle'}}});}else if(m.method==='thread/list'){lists++;reply({data:mode==='scope-change'&&lists>1?[]:[{id:'child'}],nextCursor:null});}else if(m.method==='thread/archive'){if(mode==='writer-reject')emit({id:m.id,error:{code:-32600,message:'already has an active writer'}});else if(mode!=='no-ack'){const db=new DatabaseSync(file);try{db.exec('UPDATE threads SET archived=1,archived_at=2');}finally{db.close();}reply({});}}else reply({});}});`;
 const server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'archive-coordinator',title:'fixture',version:'1'}},()=> 'fixture error',{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:()=> 'fixture error',fence:createMutationCustodyFence(path,'runtime',()=> 'fixture error')});
 const seen=async()=>{const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,'seen',{},1000) as any[];}finally{a.release();}};
 try{await run({path,codex,bridge,locks,server,action:new AdmittedResumeExecutor(path,codex,bridge,server,locks,timeout),seen});}finally{await server.dispose();}
});}

it('already loaded original needs one read and no prompt, fork or resume mutation',async()=>fixture('ok',async f=>{
 const result=await f.action.execute(actor,null,'own');assert.match(result.text,/status: already loaded/);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/read']);assert.equal(f.locks.activeTargetCount,0);assert.equal(f.bridge.selectedThreadId(),'root');
}));
it('notLoaded original is resumed and loaded status is read before verified result',async()=>fixture('unloaded',async f=>{
 const result=await f.action.execute(actor,null,'own');assert.match(result.text,/status: recovered/);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/read','thread/resume','thread/read']);assert.ok((await f.seen()).every(x=>x.params.threadId==='root'));assert.equal(f.locks.activeTargetCount,0);
}));
it('active status counts as loaded without interrupting or resending',async()=>fixture('active',async f=>{
 assert.match((await f.action.execute(actor,null,'own')).text,/already loaded/);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/read']);
}));
it('wrong actor, event and command binding fail before native operations',async()=>fixture('ok',async f=>{
 await assert.rejects(f.action.execute({...actor,userId:9n},null,'own'),/envelope differs/);await assert.rejects(f.action.execute({...actor,discordMessageId:4n},null,'own'),/envelope differs/);await assert.rejects(f.action.execute(actor,'root','own'),/envelope differs/);assert.deepEqual(await f.seen(),[]);
}));
it('missing legacy frozen binding cannot be reconstructed from current selection',async()=>fixture('ok',async f=>{
 await state.admitIngress(f.path,{ingressId:'legacy',kind:'message',eventId:4n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:4n,targetThreadId:'root',canonicalOwner:null,now:2,payload:{version:1n,plan:{Execute:{Resume:{reference:null}}}}});const db=await openInitialized(f.path);try{db.exec("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id='legacy'");}finally{db.close();}
 await assert.rejects(f.action.execute({...actor,discordMessageId:4n},null,'legacy'),/not frozen/);assert.deepEqual(await f.seen(),[]);
}));
it('control wait shares total deadline and leaves unrelated owner intact',async()=>fixture('ok',async f=>{
 const lease=await f.locks.acquire('root');try{await assert.rejects(f.action.execute(actor,null,'own'),/control wait timed out/);lease.requireTarget('root');assert.deepEqual(await f.seen(),[]);}finally{lease.release();}assert.equal(f.locks.activeTargetCount,0);
},150));
it('foreign identity, systemError or timed-out read cannot become verified loaded state',async()=>{
 for(const mode of ['wrong-id','systemError','stall'])await fixture(mode,async f=>{await assert.rejects(f.action.execute(actor,null,'own'),/verification failed.*No prompt was resent; no fork was used/);assert.equal(f.locks.activeTargetCount,0);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/read']);assert.equal(f.bridge.selectedThreadId(),'root');},200);
});
it('selection drift while acquiring root lock is rejected without retargeting',async()=>fixture('ok',async f=>{
 const lease=await f.locks.acquire('root'),pending=f.action.execute(actor,null,'own'),assertion=assert.rejects(pending,/target changed/);try{await new Promise(r=>setTimeout(r,30));f.bridge.setSelectedThreadId('child');}finally{lease.release();}await assertion;assert.deepEqual(await f.seen(),[]);assert.equal(f.locks.activeTargetCount,0);
}));
it('frozen numeric target never becomes an index lookup for another thread',async()=>fixture('ok',async f=>{
 await state.admitIngress(f.path,{ingressId:'alias',kind:'message',eventId:4n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:4n,targetThreadId:'1',canonicalOwner:null,now:2,payload:{version:1n,plan:{Execute:{Resume:{reference:'1'}}},lifecycle_binding:{target:'1',route:'Explicit',command:{Resume:{reference:'1'}}},stop_origin:{target:'1',stopRevision:0n}}});
 const db=await openInitialized(f.path);try{db.exec("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id='alias'");}finally{db.close();}
 await assert.rejects(f.action.execute({...actor,discordMessageId:4n},'1','alias'),/original target no longer resolves exactly/);assert.deepEqual(await f.seen(),[]);assert.equal(f.locks.activeTargetCount,0);
}));
it('caller cancellation during native read joins the operation before releasing its target lease',async()=>fixture('stall',async f=>{
 const c=new AbortController(),reason=new Error('cancel resume'),pending=f.action.execute(actor,null,'own',c.signal),assertion=assert.rejects(pending,e=>e===reason);
 for(let i=0;i<200;i++){if((await f.seen()).length>0)break;await new Promise(r=>setTimeout(r,5));if(i===199)throw Error('read was not observed');}
 assert.equal(f.locks.tryAcquire('root'),undefined);c.abort(reason);await assertion;assert.equal(f.locks.activeTargetCount,0);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/read']);
}));
