import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';
import {startRuntimeResident} from '../../../src/runtime/discord-runtime/resident-startup.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {selectIdleIntentIn} from '../../../src/store/idle-release-row.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';import {storeFixture} from '../../helpers/store-fixture.ts';import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
const match='native-idle-before-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts');
const code="import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(process.env.STARTS,process.pid+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});";
const config=(path:string)=>({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{STARTS:path+'.starts'}},clientInfo:{name:'idle-exit',title:'Fixture',version:'1'}});
const starts=(path:string)=>readFileSync(path+'.starts','utf8').trim().split('\n').length;
for(const mode of ['restart','close','abort','lost-restart','lost-close'] as const)test(`installed ${mode} keeps exact session until settlement ACK and actual worker exit`,{timeout:15000},async t=>storeFixture(async path=>{
 let mainCalls=0;t.mock.method(state,'settleExitedIdleOwnerExisting',()=>{mainCalls++;throw new Error('main-thread idle exit is forbidden');});
 const owner=await startRuntimeResident(config(path),path,'runtime',null,()=> 'safe'),db=await openInitialized(path),pid=owner.lifecycleSnapshot().processId!,trace=new SharedArrayBuffer(8),controller=new AbortController();
 db.prepare("INSERT INTO cdr_idle_release VALUES('i',?,1,'T','V','job',1,'Unknown','prior')").run(owner.instanceId);
 const closing=mode.includes('close'),lost=mode.startsWith('lost');const restore=instrumentStoreWorker({match,trace,...lost?{ack:'drop' as const}:{}});let pending:Promise<unknown>|undefined;
 try{pending=closing?owner.close():owner.forceRestartIfQuiescent(controller.signal);let done=false;const result=pending.then(value=>{done=true;return {ok:true,value};},error=>{done=true;return {ok:false,error};});await waitTrace(trace);
  assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');assert.equal(selectIdleIntentIn(db,'T')!.state,'Settled');assert.equal(mainCalls,0);if(mode==='abort')controller.abort(new Error('caller canceled after cleanup began'));
  await delay(30);assert.equal(done,false);assert.equal(owner.generation(),1n);assert.equal(starts(path),1);assert.equal(owner.lifecycleSnapshot().healthy,false);assert.equal(ownedWorkerUsage().Control,1);
  releaseTrace(trace);restore();const observed=await result;
  if(lost||mode==='abort'){assert.equal(observed.ok,false);assert.equal(owner.generation(),1n);assert.equal(starts(path),1);assert.throws(()=>owner.admitRequest(),/closed/);if(closing)await owner.close();else assert.equal(await owner.restartIfQuiescent(),true);}
  else assert.equal(observed.ok,true);
  assert.equal(selectIdleIntentIn(db,'T')!.revision,2n);assert.equal(ownedWorkerUsage().Control,0);assert.equal(owner.generation(),closing?1n:2n);assert.equal(starts(path),closing?1:2);await owner.close();await owner.close();assert.equal(selectIdleIntentIn(db,'T')!.revision,2n);assert.equal(mainCalls,0);
 }finally{releaseTrace(trace);restore();if(pending)await Promise.allSettled([pending]);await owner.dispose();db.close();}
}));
test('installed restart blocked on real SQLite lock keeps timers live and starts no successor',async()=>storeFixture(async path=>{
 const owner=await startRuntimeResident(config(path),path,'runtime',null,()=> 'safe'),db=await openInitialized(path),trace=new SharedArrayBuffer(12);db.prepare("INSERT INTO cdr_idle_release VALUES('i',?,1,'T','V','job',1,'Unknown','prior')").run(owner.instanceId);
 const restore=instrumentStoreWorker({match,trace,before:'Atomics.store(trace,2,1);'});let pending:Promise<boolean>|undefined;
 try{db.exec('BEGIN IMMEDIATE');pending=owner.forceRestartIfQuiescent();const result=pending.catch(e=>e);await waitTrace(trace,2);await delay(40);assert.equal(owner.generation(),1n);assert.equal(starts(path),1);assert.equal(ownedWorkerUsage().Control,1);assert.equal(selectIdleIntentIn(db,'T')!.state,'Unknown');db.exec('ROLLBACK');await waitTrace(trace);assert.equal(starts(path),1);releaseTrace(trace);restore();assert.equal(await result,true);assert.equal(owner.generation(),2n);}finally{if(db.isTransaction)db.exec('ROLLBACK');releaseTrace(trace);restore();if(pending)await Promise.allSettled([pending]);await owner.dispose();db.close();}
}));
