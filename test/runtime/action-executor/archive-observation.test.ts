import assert from 'node:assert/strict';
import {it} from 'node:test';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {archiveDescendants,archiveOwnRequest} from '../../../src/runtime/action-executor/archive-observation.ts';
import {ActionIntegerRangeError} from '../../../src/runtime/action-executor/errors.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';
import type {NewIngress} from '../../../src/store/ingress-types.ts';
async function serverFixture(pages:unknown[],run:(server:PortableResidentLifecycle,seen:()=>Promise<any[]>)=>Promise<void>){await storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");}finally{db.close();}
 const code=`import readline from 'node:readline';const pages=${JSON.stringify(pages)},seen=[];let n=0;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),reply=result=>emit({id:m.id,result});if(m.method==='initialize')reply({});else if(m.method==='initialized'){}else if(m.method==='seen')reply(seen);else{seen.push({method:m.method,params:m.params});const p=pages[n++]??{};if(p.error)emit({id:m.id,error:p.error});else reply(p);}});`;
 const server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'archive-observation',title:'fixture',version:'1'}},()=> 'fixture failure',{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:()=> 'fixture failure',fence:createMutationCustodyFence(path,'runtime',()=> 'fixture failure')});
 const seen=async()=>{const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,'seen',{},1000) as any[];}finally{a.release();}};
 try{await run(server,seen);}finally{await server.dispose();}
});}
it('descendant inventory pins all pages and preserves UTF-8 ordered complete scope',async()=>serverFixture([{data:[{id:'😀'},{id:'z'}],nextCursor:'next'},{data:[{id:'\ue000'}],nextCursor:null}],async(s,seen)=>{
 const result=await archiveDescendants(s,'root',s.generation());assert.deepEqual(result,['z','\ue000','😀']);assert.ok(Object.isFrozen(result));const calls=await seen();assert.equal(calls.length,2);assert.ok(calls.every(c=>c.method==='thread/list'));
 assert.deepEqual(calls[0].params,{ancestorThreadId:'root',archived:false,limit:100n,cursor:null,sourceKinds:['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown']});assert.equal(calls[1].params.cursor,'next');
}));
it('invalid identities, repeated/root ids and absent pagination never return partial scope',async()=>{
 for(const page of [{},{data:null,nextCursor:null},{data:[{}],nextCursor:null},{data:[{id:''}],nextCursor:null},{data:[{id:' a'}],nextCursor:null},{data:[{id:'root'}],nextCursor:null},{data:[{id:'a'},{id:'a'}],nextCursor:null},{data:[]},{data:[],nextCursor:''}])await serverFixture([page],async(s,seen)=>{await assert.rejects(archiveDescendants(s,'root',1n),/archive descendant|archive scope/);assert.equal((await seen()).length,1);});
});
it('cross-page duplicates and repeated cursors are rejected without archive request',async()=>{
 for(const second of [{data:[{id:'a'}],nextCursor:null},{data:[],nextCursor:'next'}])await serverFixture([{data:[{id:'a'}],nextCursor:'next'},second],async(s,seen)=>{await assert.rejects(archiveDescendants(s,'root',1n));assert.equal((await seen()).length,2);});
});
it('100 descendants and eleven pages are accepted only with an explicit terminal cursor',async()=>{
 const ids=Array.from({length:100},(_,i)=>({id:`id-${i}`}));await serverFixture([{data:ids,nextCursor:null}],async s=>assert.equal((await archiveDescendants(s,'root',1n)).length,100));
 await serverFixture([{data:[...ids,{id:'extra'}],nextCursor:null}],async s=>assert.rejects(archiveDescendants(s,'root',1n),/100 descendants/));
 const pages=Array.from({length:11},(_,i)=>({data:[],nextCursor:`p${i}`}));await serverFixture(pages,async(s,seen)=>{await assert.rejects(archiveDescendants(s,'root',1n),/pagination exceeded/);assert.equal((await seen()).length,11);});
 pages[10]!.nextCursor=null as unknown as string;await serverFixture(pages,async s=>assert.deepEqual(await archiveDescendants(s,'root',1n),[]));
});
it('generation mismatch, pre-cancellation and remote errors cannot authorize archive or retry',async()=>serverFixture([{error:{code:-9,message:'fixture remote error'}}],async(s,seen)=>{
 await assert.rejects(archiveDescendants(s,'root',2n));assert.equal((await seen()).length,0);const c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(archiveDescendants(s,'root',1n,c.signal),e=>e===reason);assert.equal((await seen()).length,0);
 await assert.rejects(archiveDescendants(s,'root',1n),/fixture remote error/);assert.equal((await seen()).length,1);
}));
const actor={channelId:1n,userId:2n,discordMessageId:3n};
const request=(overrides:Partial<NewIngress>={}):NewIngress=>({ingressId:'archive-original',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n,content:'!archive',plan:{Execute:{Archive:{reference:null}}}},targetThreadId:'target',canonicalOwner:null,now:1,...overrides});
async function admitted(path:string,input:NewIngress){await state.admitIngress(path,input);const db=await openInitialized(path);try{db.exec("UPDATE discord_ingress_journal SET state='executing',phase='processing'");}finally{db.close();}}
it('original archive envelope read proves exact actor/command without modifying durable row',async()=>storeFixture(async path=>{
 await admitted(path,request());const before=await state.getIngress(path,'archive-original');assert.equal(await archiveOwnRequest(path,actor,null),'archive-original');assert.deepEqual(await state.getIngress(path,'archive-original'),before);
 await assert.rejects(archiveOwnRequest(path,{...actor,userId:4n},null),/original command/);await assert.rejects(archiveOwnRequest(path,{...actor,channelId:4n},null),/original command/);await assert.rejects(archiveOwnRequest(path,actor,'target'),/original command/);
}));
it('explicit archive reference and Rust surrounding whitespace must agree in plan and command',async()=>storeFixture(async path=>{
 await admitted(path,request({payload:{version:1n,content:'\u0085 !archive target \u0085',plan:{Execute:{Archive:{reference:'target'}}}}}));assert.equal(await archiveOwnRequest(path,actor,'target'),'archive-original');
}));
it('wrong source, version, command, plan or ownership stays inadmissible',async()=>{
 for(const change of [{sourceMessageId:4n},{payload:{version:2n,content:'!archive',plan:{Execute:{Archive:{reference:null}}}}},{payload:{version:1n,content:'!stop',plan:{Execute:{Archive:{reference:null}}}}},{payload:{version:1n,content:'!archive',plan:{Execute:{Archive:{reference:null,extra:true}}}}}] as Partial<NewIngress>[])await storeFixture(async path=>{await admitted(path,request(change));await assert.rejects(archiveOwnRequest(path,actor,null),/original command/);});
 await storeFixture(async path=>{await admitted(path,request());const db=await openInitialized(path);try{db.exec("UPDATE discord_ingress_journal SET owner_id='another',owner_kind='queue'");}finally{db.close();}await assert.rejects(archiveOwnRequest(path,actor,null),/original command/);});
});
it('missing event returns null before database access, integer overflow and cancellation are explicit',async()=>{
 assert.equal(await archiveOwnRequest('/path-that-does-not-exist',{...actor,discordMessageId:null},null),null);
 await assert.rejects(archiveOwnRequest('/path-that-does-not-exist',{...actor,discordMessageId:1n<<63n},null),ActionIntegerRangeError);
 const c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(archiveOwnRequest('/path-that-does-not-exist',actor,null,c.signal),e=>e===reason);
 let calls=0;const hostile={...actor,get channelId(){calls++;return 1n;}};await assert.rejects(archiveOwnRequest('/path-that-does-not-exist',hostile,null),TypeError);assert.equal(calls,0);
});
