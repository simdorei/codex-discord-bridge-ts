import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';
import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {ActionTargetServices} from '../../../src/runtime/action-executor/action-target.ts';
import {ActionThreadSelection} from '../../../src/runtime/action-executor/thread-selection.ts';
import {OpenThreadAction} from '../../../src/runtime/action-executor/open-thread.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
async function fixture(mode:string,run:(f:{action:OpenThreadAction;bridge:BridgeState;seen():Promise<any[]>})=>Promise<void>,timeout=1000){await storeFixture(async path=>{
 const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");db.close();const state=join(dirname(path),'codex.sqlite'),codex=new DatabaseSync(state);try{codex.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES('target','Original title','/project',1,0)");}finally{codex.close();}
 const code=`import readline from 'node:readline';const seen=[],mode=${JSON.stringify(mode)};const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),reply=result=>emit({id:m.id,result});if(m.method==='initialize')reply({});else if(m.method==='initialized'){}else if(m.method==='seed'){emit(mode.startsWith('active')?{method:'turn/started',params:{threadId:'target',turnId:'original-turn'}}:{method:'turn/completed',params:{threadId:'target',turnId:'old'}});reply({});}else if(m.method==='seen')reply(seen);else{seen.push({method:m.method,params:m.params});if(mode==='hang')return;if(mode==='reject'||mode==='active-reject')emit({id:m.id,error:{code:-8,message:'fixture rejected'}});else reply({thread:{id:'target'}});}});`;
 const render=(e:unknown)=>e instanceof Error?e.message:'opaque';const server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'open-action',title:'fixture',version:'1'}},render,{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:render,fence:createMutationCustodyFence(path,'runtime',render)});
 const bridge=new BridgeState(join(dirname(path),'bridge.json'));bridge.setSelectedThreadId('old-selection');const queue=new QueueStartCoordinator(path,new AppServerTurnBackend(server,render)),targets=new ActionTargetServices(path,bridge,queue,{preparePrompt:async()=>assert.fail('no prompt'),busyResult:async()=>assert.fail('no busy')}),action=new OpenThreadAction(new ActionThreadSelection(state,path,bridge),targets,bridge,server,timeout);
 const call=async(method:string)=>{const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};try{await call('seed');await run({action,bridge,seen:async()=>await call('seen') as any[]});}finally{await server.dispose();}
});}
test('explicit saved reference resumes original thread then persists selection without starting a turn',async()=>fixture('idle',async f=>{
 assert.deepEqual(await f.action.open('target',false),{text:'Opened Codex thread\nthread_id: target\ntitle: Original title',waitsForFinal:false,ui:null});assert.equal(f.bridge.selectedThreadId(),'target');assert.deepEqual((await f.seen()).map(x=>x.method),['thread/resume']);assert.equal((await f.seen())[0].params.threadId,'target');
}));
test('active open requires explicit abort and sends neither interrupt nor resume otherwise',async()=>fixture('active',async f=>{
 await assert.rejects(f.action.open('target',false),/use open_abort/);assert.equal(f.bridge.selectedThreadId(),'old-selection');assert.deepEqual(await f.seen(),[]);
}));
test('explicit open-abort binds original turn before resume and changes selection only afterward',async()=>fixture('active',async f=>{
 await f.action.open('target',true);const calls=await f.seen();assert.deepEqual(calls.map(x=>x.method),['turn/interrupt','thread/resume']);assert.equal(calls[0].params.turnId,'original-turn');assert.equal(calls[0].params.threadId,'target');assert.equal(f.bridge.selectedThreadId(),'target');
}));
test('remote interrupt rejection prevents resume and selection change',async()=>fixture('active-reject',async f=>{
 await assert.rejects(f.action.open('target',true),/fixture rejected/);assert.deepEqual((await f.seen()).map(x=>x.method),['turn/interrupt']);assert.equal(f.bridge.selectedThreadId(),'old-selection');
}));
test('remote resume rejection has no fork fallback or selection success',async()=>fixture('reject',async f=>{
 await assert.rejects(f.action.open('target',false),/fixture rejected/);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/resume']);assert.equal(f.bridge.selectedThreadId(),'old-selection');
}));
test('caller timeout reaches actual resident resume and timeout does not publish selected target',async()=>fixture('hang',async f=>{
 const started=performance.now();await assert.rejects(f.action.open('target',false),/timed out|timeout/i);assert.ok(performance.now()-started<1000);assert.equal(f.bridge.selectedThreadId(),'old-selection');assert.deepEqual((await f.seen()).map(x=>x.method),['thread/resume']);
},47));
test('pre-cancelled and invalid reference open perform no native mutation',async()=>fixture('idle',async f=>{
 const a=new AbortController(),reason=new Error('shutdown');a.abort(reason);await assert.rejects(f.action.open('target',true,a.signal),e=>e===reason);await assert.rejects(f.action.open('missing',false));assert.deepEqual(await f.seen(),[]);assert.equal(f.bridge.selectedThreadId(),'old-selection');
}));
