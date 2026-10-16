import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {NativeDeadGenerationOwner} from '../../../src/runtime/native-dead-generation.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {ResidentStateError} from '../../../src/app-server/resident-state.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {startRuntimeResident,RuntimeResidentStartupCleanupError} from '../../../src/runtime/discord-runtime/resident-startup.ts';
import {IdleObservationError} from '../../../src/app-server/notification-state.ts';
const render=(error:unknown)=>error instanceof Error?error.message:'opaque';
const script="import fs from 'node:fs';import readline from 'node:readline';fs.writeFileSync(process.env.PID_FILE,String(process.pid));readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});";
const config=(path:string)=>({process:{executable:process.execPath,arguments:['--input-type=module','-e',script],environment:{PID_FILE:join(dirname(path),'child.pid')}},clientInfo:{name:'startup-fixture',title:'fixture',version:'1'}});
test('native startup activates custody and idle tracking before publishing the resident',async()=>storeFixture(async path=>{
 const owner=await startRuntimeResident(config(path),path,'runtime',42n,render);
 try{
  assert.equal(owner.observationTrackingEnabled(),true);assert.equal(owner.lifecycleSnapshot().healthy,true);
  const db=await openInitialized(path);try{
   assert.equal(db.prepare('SELECT runtime_id FROM codex_app_server_runtime').get()!.runtime_id,'runtime');
   assert.equal(db.prepare('SELECT runtime_id FROM codex_mutation_runtime').get()!.runtime_id,'runtime');
   const row=db.prepare('SELECT owner_id,generation,active FROM cdr_observation_streams').get()!;
   assert.equal(row.owner_id,owner.instanceId);assert.equal(row.generation,1);assert.equal(row.active,1);
  }finally{db.close();}
 }finally{await owner.dispose();}
 assert.equal(owner.lifecycleSnapshot().processId,null);
}));
test('failed idle installation reaps the actual child before surfacing its primary error',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec("CREATE TRIGGER reject_stream BEFORE INSERT ON cdr_observation_streams BEGIN SELECT RAISE(ABORT,'fixture activation denied'); END");}finally{db.close();}
 await assert.rejects(startRuntimeResident(config(path),path,'runtime',null,render),e=>e instanceof IdleObservationError&&e.message.includes('Native observation result unconfirmed')&&!e.message.includes('fixture activation denied'));
 const pid=Number(readFileSync(join(dirname(path),'child.pid'),'utf8'));
 assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');
}));
test('pre-aborted startup creates neither database nor child',async()=>storeFixture(async path=>{
 const stop=new AbortController(),reason={stop:true};stop.abort(reason);
 await assert.rejects(startRuntimeResident(config(path),path,'runtime',null,render,stop.signal),e=>e===reason);
 assert.equal(existsSync(path),false);assert.equal(existsSync(join(dirname(path),'child.pid')),false);
}));
test('invalid startup channel fails before native spawn',async()=>storeFixture(async path=>{
 await assert.rejects(startRuntimeResident(config(path),path,'runtime',1n<<63n,render),TypeError);
 assert.equal(existsSync(path),false);assert.equal(existsSync(join(dirname(path),'child.pid')),false);
}));
test('cleanup failure value preserves both identities and the retry owner without coercion',()=>{
 const primary={primary:true},cleanup={cleanup:true},owner={} as any;
 const error=new RuntimeResidentStartupCleanupError(primary,cleanup,owner);
 assert.equal(error.cause,primary);assert.deepEqual(error.errors,[primary,cleanup]);assert.equal(error.owner,owner);
});

const nativeMatch='native-dead-generation-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts');
for(const mode of ['success','drop','duplicate','malformed','crash','abort','timeout'] as const)test(`resident spawn waits for confirmed joined activation: ${mode}`,{timeout:15000},async()=>storeFixture(async path=>{
 const trace=new SharedArrayBuffer(8),controller=new AbortController(),restore=instrumentStoreWorker({match:nativeMatch,trace,...(mode==='drop'||mode==='duplicate'?{ack:mode}:{}),...(mode==='malformed'?{before:"parentPort.postMessage=value=>post({...value,binding:'wrong'});"}:{}),...(mode==='crash'?{after:"Atomics.wait(trace,1,0,15000);throw new Error('committed startup crash');"}:{})});
 let done=false,owner:Awaited<ReturnType<typeof startRuntimeResident>>|undefined;const pending=startRuntimeResident(config(path),path,'runtime',null,render,controller.signal),observed=pending.then(value=>{done=true;owner=value;return null;},error=>{done=true;return error;});
 try{
  await waitTrace(trace);const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT runtime_id FROM codex_app_server_runtime').get()!.runtime_id,'runtime');assert.equal(db.prepare('SELECT runtime_id FROM codex_mutation_runtime').get()!.runtime_id,'runtime');}finally{db.close();}
  assert.equal(existsSync(join(dirname(path),'child.pid')),false);assert.equal(ownedWorkerUsage().Control,1);if(mode==='abort')controller.abort(new Error('cancel startup'));
  await new Promise(r=>setTimeout(r,mode==='timeout'?5100:30));assert.equal(done,false);assert.equal(existsSync(join(dirname(path),'child.pid')),false);assert.equal(ownedWorkerUsage().Control,1);
 }finally{releaseTrace(trace);restore();}
 const outcome=await observed;try{assert.equal(ownedWorkerUsage().Control,0);if(mode==='success'){assert.equal(outcome,null);assert.equal(owner!.lifecycleSnapshot().healthy,true);}else{assert.ok(outcome instanceof ResidentStateError);assert.equal(existsSync(join(dirname(path),'child.pid')),false);}}
 finally{await owner?.dispose();}
}));
test('late cancellation after joined activation closes that owner without spawning',async t=>storeFixture(async path=>{
 const controller=new AbortController(),reason=new Error('late cancel'),start=NativeDeadGenerationOwner.startWithCustodyActivation;let dead:NativeDeadGenerationOwner|undefined;
 t.mock.method(NativeDeadGenerationOwner,'startWithCustodyActivation',async(...args:Parameters<typeof start>)=>{dead=await start(...args);controller.abort(reason);return dead;});
 await assert.rejects(startRuntimeResident(config(path),path,'runtime',null,render,controller.signal),e=>e===reason);
 const captured=dead;assert.ok(captured);assert.throws(()=>captured.capture('resident',{generation:1n,closedReason:'EOF',activeTurns:[],serverRequests:[]}),/closed/);assert.equal(ownedWorkerUsage().Control,0);assert.equal(existsSync(join(dirname(path),'child.pid')),false);
}));
test('original config and relative path survive cwd changes; both runtime IDs precede initialize',async()=>storeFixture(async path=>storeFixture(async other=>{
 const originalCwd=process.cwd(),trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:nativeMatch,trace});
 const code="import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import readline from 'node:readline';fs.writeFileSync(process.env.PID_FILE,String(process.pid));readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){const db=new DatabaseSync(process.env.STORE,{readOnly:true});fs.writeFileSync(process.env.IDS,JSON.stringify({dead:db.prepare('SELECT runtime_id FROM codex_app_server_runtime').get().runtime_id,mutation:db.prepare('SELECT runtime_id FROM codex_mutation_runtime').get().runtime_id,name:m.params.clientInfo.name}));db.close();}if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});";
 const original={process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{PID_FILE:join(dirname(path),'child.pid'),STORE:path,IDS:path+'.ids'}},clientInfo:{name:'original',title:'fixture',version:'1'}};
 let owner:Awaited<ReturnType<typeof startRuntimeResident>>|undefined;const pending=startRuntimeResident(original,relative(originalCwd,path),'original-runtime',null,render);void pending.catch(()=>{});
 try{
  await waitTrace(trace);original.clientInfo.name='changed';original.process.arguments[2]="throw new Error('changed process config')";original.process.environment.STORE=other;process.chdir(dirname(other));releaseTrace(trace);restore();owner=await pending;
  assert.deepEqual(JSON.parse(readFileSync(path+'.ids','utf8')),{dead:'original-runtime',mutation:'original-runtime',name:'original'});assert.equal(existsSync(other),false);
  await owner.request('thread/settings/update',{threadId:'T'},1000);const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_observation_streams WHERE active=1').get()!.n,1);assert.equal(db.prepare('SELECT runtime_id FROM codex_mutation_attempts').get()!.runtime_id,'original-runtime');}finally{db.close();}
 }finally{process.chdir(originalCwd);releaseTrace(trace);restore();await Promise.allSettled([pending]);await owner?.dispose();}
})));
test('late runtime marker change after native mutation begin still fails the final wire guard',async()=>storeFixture(async path=>{
 const cfg=config(path),wire=path+'.wire';cfg.process.arguments[2]="import fs from 'node:fs';import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method!=='initialize'&&m.method!=='initialized')fs.appendFileSync("+JSON.stringify(wire)+",line+'\\n');if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});";
 const owner=await startRuntimeResident(cfg,path,'runtime',null,render),db=new DatabaseSync(path),trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'native-mutation-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts'),trace});
 const pending=owner.request('thread/settings/update',{threadId:'T'},5000),rejected=assert.rejects(pending);let released=false;
 try{await waitTrace(trace);assert.equal(db.prepare('SELECT state FROM codex_mutation_attempts').get()!.state,'prepared');db.exec("UPDATE codex_mutation_runtime SET runtime_id='late-writer'");assert.equal(existsSync(wire),false);releaseTrace(trace);restore();released=true;await rejected;assert.equal(existsSync(wire),false);assert.equal(db.prepare('SELECT state FROM codex_mutation_attempts').get()!.state,'prepared');}
 finally{if(!released){releaseTrace(trace);restore();}await Promise.allSettled([pending]);await owner.dispose();db.close();}
}));

for(const phase of ['native-idle-before-worker','native-observation-ledger-worker'] as const)for(const mode of ['success','malformed','abort'] as const)test(`post-spawn installation waits exact ${phase} join: ${mode}`,{timeout:15000},async()=>storeFixture(async path=>{
 const trace=new SharedArrayBuffer(8),controller=new AbortController(),restore=instrumentStoreWorker({match:phase+(import.meta.url.endsWith('.js')?'.js':'.ts'),trace,...(mode==='malformed'?{before:"parentPort.postMessage=value=>post({...value,value:{...value.value,nonce:'wrong'}});"}:{})});
 let done=false,owner:Awaited<ReturnType<typeof startRuntimeResident>>|undefined;const pending=startRuntimeResident(config(path),path,'runtime',null,render,controller.signal),observed=pending.then(value=>{done=true;owner=value;return null;},error=>{done=true;return error;});
 try{
  await waitTrace(trace);assert.equal(existsSync(join(dirname(path),'child.pid')),true);assert.equal(done,false);
  const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_observation_streams').get()!.n,phase==='native-idle-before-worker'?0:1);}finally{db.close();}
  if(mode==='abort')controller.abort(new Error('cancel installation'));let ticks=0;await new Promise(r=>setTimeout(()=>{ticks++;r(null);},40));assert.equal(ticks,1);assert.equal(done,false);
 }finally{releaseTrace(trace);restore();}
 const result=await observed;try{if(mode==='success'){assert.equal(result,null);assert.equal(owner!.observationTrackingEnabled(),true);}else{assert.ok(result instanceof IdleObservationError);const pid=Number(readFileSync(join(dirname(path),'child.pid'),'utf8'));assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');}assert.equal(ownedWorkerUsage().Control,0);assert.equal(ownedWorkerUsage().Observation,0);}finally{await owner?.dispose();}
}));
