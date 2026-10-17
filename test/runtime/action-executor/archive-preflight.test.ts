import assert from 'node:assert/strict';import {it} from 'node:test';import {DatabaseSync} from 'node:sqlite';import {join,dirname} from 'node:path';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {ArchiveTargetVerifier} from '../../../src/runtime/action-executor/archive-preflight.ts';
import {ActionThreadSelection} from '../../../src/runtime/action-executor/thread-selection.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';
async function serverFixture(pages:unknown[],run:(server:PortableResidentLifecycle,seen:()=>Promise<any[]>,path:string)=>Promise<void>){await storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");}finally{db.close();}
 const code=`import readline from 'node:readline';const pages=${JSON.stringify(pages)},seen=[];let n=0;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),reply=result=>emit({id:m.id,result});if(m.method==='initialize')reply({});else if(m.method==='initialized'){}else if(m.method==='seen')reply(seen);else{seen.push({method:m.method,params:m.params});const p=pages[n++]??{};if(p.error)emit({id:m.id,error:p.error});else reply(p);}});`;
 const server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'archive-observation',title:'fixture',version:'1'}},()=> 'fixture failure',{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:()=> 'fixture failure',fence:createMutationCustodyFence(path,'runtime',()=> 'fixture failure')});
 const seen=async()=>{const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,'seen',{},1000) as any[];}finally{a.release();}};
 try{await run(server,seen,path);}finally{await server.dispose();}
});}

function setup(path:string,server:PortableResidentLifecycle){
 const codex=join(dirname(path),'codex.sqlite'),bridge=new BridgeState(join(dirname(path),'bridge.json'));bridge.setSelectedThreadId('target');
 const db=new DatabaseSync(codex);try{db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES ('target','Title','/tmp',1,0,0),('old','Old','/tmp',1,1,2)");}finally{db.close();}
 return {bridge,verifier:new ArchiveTargetVerifier(path,codex,new ActionThreadSelection(codex,path,bridge),server,1000)};
}
it('preflight accepts active stored idle target without any archive dispatch',async()=>serverFixture([],async(s,seen,path)=>{
 const f=setup(path,s);await f.verifier.preflight(1n,null,'target',1n,null);assert.deepEqual(await seen(),[]);assert.equal(await state.archiveTargetFenced(path,'target'),false);
}));
it('generation, changed selection and archived or missing storage reject without dispatch',async()=>serverFixture([],async(s,seen,path)=>{
 const f=setup(path,s);await assert.rejects(f.verifier.preflight(1n,null,'target',2n,null),/connection/);f.bridge.setSelectedThreadId('other');await assert.rejects(f.verifier.preflight(1n,null,'target',1n,null),/room target changed/);
 await f.verifier.preflight(0n,'target','target',1n,null);for(const id of ['old','missing'])await assert.rejects(f.verifier.preflight(0n,id,id,1n,null),/active stored thread/);assert.deepEqual(await seen(),[]);
}));
it('unbound ingress is conservatively relevant and exact own exclusion remains explicit',async()=>serverFixture([],async(s,seen,path)=>{
 const f=setup(path,s);await state.admitIngress(path,{ingressId:'own',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n},targetThreadId:null,canonicalOwner:null,now:1});
 assert.equal(await state.unfinishedArchiveRequest(path,'target',null),'own');await assert.rejects(f.verifier.preflight(1n,null,'target',1n,null),/unfinished ingress/);await f.verifier.preflight(1n,null,'target',1n,'own');assert.equal((await state.getIngress(path,'own'))?.state,'staged');assert.deepEqual(await seen(),[]);
}));
it('queued work and prompt intake block independently',async()=>{
 for(const kind of ['queue','intake'])await serverFixture([],async(s,seen,path)=>{const f=setup(path,s);
 if(kind==='queue')await state.enqueue(path,{jobId:'j',targetThreadId:'target',channelId:1n,ownerUserId:2n,discordMessageId:3n,appServerGeneration:1n,prompt:'hi',queued:true,ackSent:false,createdAt:1});
 else{const db=await openInitialized(path);try{db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('j','target',1,2,3,'hi',1,0,1,1)");}finally{db.close();}}
 await assert.rejects(f.verifier.preflight(1n,null,'target',1n,null),/queued, running, or intake/);assert.deepEqual(await seen(),[]);
 });
});
it('loadIdle pins generation and requires exact resumed and read identity with idle status',async()=>serverFixture([{thread:{id:'target'}},{thread:{id:'target',status:{type:'idle'}}}],async(s,seen,path)=>{
 await setup(path,s).verifier.loadIdle('target',1n);const calls=await seen();assert.deepEqual(calls.map(x=>x.method),['thread/resume','thread/read']);assert.equal(calls[1].params.includeTurns,false);assert.equal(calls[0].params.threadId,'target');
}));
it('bad resume identity short circuits read, and non-idle or mismatched read rejects',async()=>{
 for(const response of [{},{thread:{id:'other'}}])await serverFixture([response],async(s,seen,path)=>{await assert.rejects(setup(path,s).verifier.loadIdle('target',1n),/resume returned/);assert.equal((await seen()).length,1);});
 for(const response of [{thread:{id:'other',status:{type:'idle'}}},{thread:{id:'target',status:{type:'active'}}},{thread:{id:'target'}}])await serverFixture([{thread:{id:'target'}},response],async(s,seen,path)=>{await assert.rejects(setup(path,s).verifier.loadIdle('target',1n),/confirmed idle/);assert.equal((await seen()).length,2);});
});
it('original writer rejection never forks and pre-cancellation performs no request',async()=>serverFixture([{error:{code:-32600,message:'already has an active writer'}}],async(s,seen,path)=>{
 const f=setup(path,s),c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(f.verifier.loadIdle('target',1n,c.signal),e=>e===reason);await assert.rejects(f.verifier.preflight(1n,null,'target',1n,null,c.signal),e=>e===reason);assert.deepEqual(await seen(),[]);
 await assert.rejects(f.verifier.loadIdle('target',1n),/owns original thread.*no fork/);assert.equal((await seen()).length,1);
}));
