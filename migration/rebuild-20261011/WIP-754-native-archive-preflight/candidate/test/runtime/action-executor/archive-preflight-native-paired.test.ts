import {createNativeQueueReadState} from '../../../src/runtime/queue-runner/native-read-state.ts';
import {createNativePromptIntakeState} from '../../../src/runtime/prompt-intake/native-state.ts';
import {createNativeActionThreadReads} from '../../../src/runtime/action-executor/thread-selection-native.ts';
import type {ArchivePreflightReads} from '../../../src/runtime/action-executor/archive-preflight.ts';
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

function setup(path:string,server:PortableResidentLifecycle,override?:Partial<ArchivePreflightReads>){
 const codex=join(dirname(path),'codex.sqlite'),bridge=new BridgeState(join(dirname(path),'bridge.json'));bridge.setSelectedThreadId('target');
 const db=new DatabaseSync(codex);try{db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES ('target','Title','/tmp',1,0,0),('old','Old','/tmp',1,1,2)");}finally{db.close();}
 const reads={listFiltered:createNativeQueueReadState(path).listFiltered,listPromptIntakes:createNativePromptIntakeState(path).listPromptIntakes,exact:createNativeActionThreadReads(codex,bridge.path()).exact,...override};return {bridge,verifier:new ArchiveTargetVerifier(path,codex,new ActionThreadSelection(codex,path,bridge),server,1000,reads)};
}
it('native preflight: preflight accepts active stored idle target without any archive dispatch',async()=>serverFixture([],async(s,seen,path)=>{
 const f=setup(path,s);await f.verifier.preflight(1n,null,'target',1n,null);assert.deepEqual(await seen(),[]);assert.equal(await state.archiveTargetFenced(path,'target'),false);
}));
it('native preflight: generation, changed selection and archived or missing storage reject without dispatch',async()=>serverFixture([],async(s,seen,path)=>{
 const f=setup(path,s);await assert.rejects(f.verifier.preflight(1n,null,'target',2n,null),/connection/);f.bridge.setSelectedThreadId('other');await assert.rejects(f.verifier.preflight(1n,null,'target',1n,null),/room target changed/);
 await f.verifier.preflight(0n,'target','target',1n,null);for(const id of ['old','missing'])await assert.rejects(f.verifier.preflight(0n,id,id,1n,null),/active stored thread/);assert.deepEqual(await seen(),[]);
}));
it('native preflight: unbound ingress is conservatively relevant and exact own exclusion remains explicit',async()=>serverFixture([],async(s,seen,path)=>{
 const f=setup(path,s);await state.admitIngress(path,{ingressId:'own',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n},targetThreadId:null,canonicalOwner:null,now:1});
 assert.equal(await state.unfinishedArchiveRequest(path,'target',null),'own');await assert.rejects(f.verifier.preflight(1n,null,'target',1n,null),/unfinished ingress/);await f.verifier.preflight(1n,null,'target',1n,'own');assert.equal((await state.getIngress(path,'own'))?.state,'staged');assert.deepEqual(await seen(),[]);
}));
it('native preflight: queued work and prompt intake block independently',async()=>{
 for(const kind of ['queue','intake'])await serverFixture([],async(s,seen,path)=>{const f=setup(path,s);
 if(kind==='queue')await state.enqueue(path,{jobId:'j',targetThreadId:'target',channelId:1n,ownerUserId:2n,discordMessageId:3n,appServerGeneration:1n,prompt:'hi',queued:true,ackSent:false,createdAt:1});
 else{const db=await openInitialized(path);try{db.exec("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES ('j','target',1,2,3,'hi',1,0,1,1)");}finally{db.close();}}
 await assert.rejects(f.verifier.preflight(1n,null,'target',1n,null),/queued, running, or intake/);assert.deepEqual(await seen(),[]);
 });
});
it('native preflight: loadIdle pins generation and requires exact resumed and read identity with idle status',async()=>serverFixture([{thread:{id:'target'}},{thread:{id:'target',status:{type:'idle'}}}],async(s,seen,path)=>{
 await setup(path,s).verifier.loadIdle('target',1n);const calls=await seen();assert.deepEqual(calls.map(x=>x.method),['thread/resume','thread/read']);assert.equal(calls[1].params.includeTurns,false);assert.equal(calls[0].params.threadId,'target');
}));
it('native preflight: bad resume identity short circuits read, and non-idle or mismatched read rejects',async()=>{
 for(const response of [{},{thread:{id:'other'}}])await serverFixture([response],async(s,seen,path)=>{await assert.rejects(setup(path,s).verifier.loadIdle('target',1n),/resume returned/);assert.equal((await seen()).length,1);});
 for(const response of [{thread:{id:'other',status:{type:'idle'}}},{thread:{id:'target',status:{type:'active'}}},{thread:{id:'target'}}])await serverFixture([{thread:{id:'target'}},response],async(s,seen,path)=>{await assert.rejects(setup(path,s).verifier.loadIdle('target',1n),/confirmed idle/);assert.equal((await seen()).length,2);});
});
it('native preflight: original writer rejection never forks and pre-cancellation performs no request',async()=>serverFixture([{error:{code:-32600,message:'already has an active writer'}}],async(s,seen,path)=>{
 const f=setup(path,s),c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(f.verifier.loadIdle('target',1n,c.signal),e=>e===reason);await assert.rejects(f.verifier.preflight(1n,null,'target',1n,null,c.signal),e=>e===reason);assert.deepEqual(await seen(),[]);
 await assert.rejects(f.verifier.loadIdle('target',1n),/owns original thread.*no fork/);assert.equal((await seen()).length,1);
}));

it('native preflight: captured full-list operations preserve order and never filter away other rows',async()=>serverFixture([],async(s,seen,path)=>{
 const calls:string[]=[],queue=createNativeQueueReadState(path),intake=createNativePromptIntakeState(path);
 const port:{-readonly [K in keyof ArchivePreflightReads]?:ArchivePreflightReads[K]}={listFiltered:async(p,t,g)=>{assert.equal(p,path);assert.equal(t,null);assert.equal(g,null);calls.push('queue');return queue.listFiltered(p,t,g);},listPromptIntakes:async p=>{calls.push('intake');return intake.listPromptIntakes(p);}};
 const f=setup(path,s,port);port.listFiltered=async()=>{throw new Error('replacement must not run');};await f.verifier.preflight(0n,'target','target',1n,null);assert.deepEqual(calls,['queue','intake']);assert.deepEqual(await seen(),[]);
}));
it('native preflight: queue hit masks intake and exact read even when those would fail',async()=>serverFixture([],async(s,seen,path)=>{
 const f=setup(path,s,{listPromptIntakes:async()=>{throw new Error('unexpected intake');},exact:async()=>{throw new Error('unexpected exact');}});
 await state.enqueue(path,{jobId:'j',targetThreadId:'target',channelId:1n,ownerUserId:2n,discordMessageId:3n,appServerGeneration:1n,prompt:'hi',queued:true,ackSent:false,createdAt:1});
 await assert.rejects(f.verifier.preflight(0n,'target','target',1n,null),/queued, running, or intake/);assert.deepEqual(await seen(),[]);assert.equal((await state.listQueueJobs(path)).length,1);
}));
it('native preflight: every read rejection retains identity and never becomes permission',async()=>{
 for(const field of ['listFiltered','listPromptIntakes','exact'] as const)await serverFixture([],async(s,seen,path)=>{const reason=new Error(field);const f=setup(path,s,{[field]:async()=>{throw reason;}});await assert.rejects(f.verifier.preflight(0n,'target','target',1n,null),e=>e===reason);assert.deepEqual(await seen(),[]);});
});
it('native preflight: cancellation waits for admitted read and prevents next stage',async()=>serverFixture([],async(s,seen,path)=>{
 let release!:()=>void,entered!:()=>void;const wait=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;}),c=new AbortController(),reason=new Error('cancel');let finished=false,next=0;
 const f=setup(path,s,{listFiltered:async()=>{entered();await wait;return [];},listPromptIntakes:async()=>{next++;return [];}}),work=f.verifier.preflight(0n,'target','target',1n,null,c.signal);const checked=assert.rejects(work,e=>e===reason).finally(()=>{finished=true;});await ready;c.abort(reason);await new Promise<void>(r=>setImmediate(r));assert.equal(finished,false);release();await checked;assert.equal(next,0);assert.deepEqual(await seen(),[]);
}));
it('native preflight: unrelated malformed queue row is not hidden by target filtering',async()=>serverFixture([],async(s,seen,path)=>{
 const f=setup(path,s);await state.enqueue(path,{jobId:'foreign',targetThreadId:'other',channelId:1n,ownerUserId:2n,discordMessageId:3n,appServerGeneration:1n,prompt:'hi',queued:true,ackSent:false,createdAt:1});const db=await openInitialized(path);try{db.exec("UPDATE codex_turn_queue SET baseline_turn_ids='{' WHERE job_id='foreign'");}finally{db.close();}
 await assert.rejects(f.verifier.preflight(0n,'target','target',1n,null),/Queue read unavailable/);assert.deepEqual(await seen(),[]);
}));
