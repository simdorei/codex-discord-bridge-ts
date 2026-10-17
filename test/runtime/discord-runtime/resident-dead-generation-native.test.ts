import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {startRuntimeResident} from '../../../src/runtime/discord-runtime/resident-startup.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';import {storeFixture} from '../../helpers/store-fixture.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
const match='native-dead-generation-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts');
const render=(e:unknown)=>e instanceof Error?e.message:'safe';
const code=`import fs from 'node:fs';import readline from 'node:readline';fs.appendFileSync(process.env.STARTS,process.pid+'\\n');const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.method==='seed'){emit({method:'turn/started',params:{threadId:'T',turnId:'V'}});emit({id:'approval',method:'approval',params:{threadId:'P'}});}if(m.method==='die'){process.exit(0);return;}if(m.id!==undefined)emit({id:m.id,result:{}});});`;
const config=(path:string)=>({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{STARTS:path+'.starts'}},clientInfo:{name:'dead-native',title:'Fixture',version:'1'}});
async function call(owner:PortableResidentLifecycle,method:string){const a=owner.admitRequest();try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}}
async function die(owner:PortableResidentLifecycle){await call(owner,'seed');const watch=owner.subscribeLifecycleChanges();try{await assert.rejects(call(owner,'die'));if(!owner.lifecycleSnapshot().restartPending)await watch.changed(AbortSignal.timeout(2000));}finally{watch.dispose();}}
async function restart(owner:PortableResidentLifecycle,signal?:AbortSignal):Promise<boolean>{for(;;){try{if(await owner.restartIfQuiescent(signal))return true;}catch(e){if(!(e instanceof AggregateError&&e.errors.some(x=>x?.code==='ERR_STREAM_PREMATURE_CLOSE')))throw e;}await delay(1);}}
const starts=(path:string)=>readFileSync(path+'.starts','utf8').trim().split('\n').length;
for(const mode of ['success','drop','duplicate','malformed','crash','abort','timeout'] as const)test(`installed native ${mode} cannot settle or replace before native exit`,{timeout:20000},async t=>storeFixture(async path=>{
 let poison=0;t.mock.method(state,'captureDeadGenerationExisting',()=>{poison++;throw new Error('main capture is forbidden');});
 let owner:PortableResidentLifecycle|undefined,restore:(()=>void)|undefined;const trace=new SharedArrayBuffer(8),controller=new AbortController();let pending:Promise<boolean>|undefined;
 try{
  owner=await startRuntimeResident(config(path),path,'runtime',99n,render);await die(owner);
  restore=instrumentStoreWorker({match,trace,...(mode==='drop'||mode==='duplicate'?{ack:mode}:{}),...(mode==='malformed'?{before:"parentPort.postMessage=value=>post({...value,binding:'changed'});"}:{}),...(mode==='crash'?{after:"Atomics.wait(trace,1,0,15000);throw new Error('commit crash');"}:{})});
  const original=owner;pending=restart(original,controller.signal);let done=false;const observed=pending.then(value=>{done=true;return value;},error=>{done=true;return error;});await waitTrace(trace);if(mode==='abort')controller.abort(new Error('cancel restart'));
  const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT count(*) AS n FROM codex_dead_generation_incidents').get()!.n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_delivery_outbox').get()!.n,2);}finally{db.close();}
  await delay(mode==='timeout'?5100:30);assert.equal(done,false);assert.equal(original.generation(),1n);assert.equal(original.lifecycleSnapshot().restartPending,true);assert.equal(starts(path),1);assert.equal(ownedWorkerUsage().Control,1);assert.equal(poison,0);
  releaseTrace(trace);restore();restore=undefined;const result=await observed;
  if(mode==='success'){assert.equal(result,true);assert.equal(original.generation(),2n);assert.equal(starts(path),2);}
  else{assert.ok(result instanceof Error);assert.equal(original.generation(),1n);assert.equal(starts(path),1);assert.equal(original.lifecycleSnapshot().restartPending,true);await restart(original);assert.equal(original.generation(),2n);assert.equal(starts(path),2);}
  const after=await openInitialized(path);try{assert.equal(after.prepare('SELECT count(*) AS n FROM codex_dead_generation_incidents').get()!.n,1);assert.equal(after.prepare('SELECT count(*) AS n FROM codex_delivery_outbox').get()!.n,2);}finally{after.close();}
 }finally{releaseTrace(trace);restore?.();if(pending)await Promise.allSettled([pending]);if(owner)await owner.dispose();}
}));
test('concurrent restart and terminal close remain behind the original restart native owner', {timeout:15000},async()=>storeFixture(async path=>{
 const owner=await startRuntimeResident(config(path),path,'runtime',99n,render),trace=new SharedArrayBuffer(8);let restore:(()=>void)|undefined,p:Promise<boolean>|undefined,q:Promise<boolean>|undefined,close:Promise<void>|undefined;
 try{await die(owner);restore=instrumentStoreWorker({match,trace,ack:'drop'});p=restart(owner);const failed=assert.rejects(p);await waitTrace(trace);q=owner.restartGenerationIfQuiescent(1n);const qObserved=q.catch(e=>e);close=owner.close();let closed=false;void close.then(()=>{closed=true;},()=>{closed=true;});await delay(30);assert.equal(closed,false);assert.equal(owner.generation(),1n);assert.equal(starts(path),1);releaseTrace(trace);restore();restore=undefined;await failed;const second=await qObserved;if(second instanceof Error){assert.ok(second instanceof AggregateError);await owner.close();}await close;assert.equal(ownedWorkerUsage().Control,0);assert.equal(owner.lifecycleSnapshot().processId,null);
 }finally{releaseTrace(trace);restore?.();await Promise.allSettled([p,q,close]);await owner.dispose();}
}));
