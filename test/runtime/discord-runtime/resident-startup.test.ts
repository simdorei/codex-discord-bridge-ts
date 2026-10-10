import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
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
 await assert.rejects(startRuntimeResident(config(path),path,'runtime',null,render),e=>e instanceof IdleObservationError&&e.message.includes('fixture activation denied'));
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
