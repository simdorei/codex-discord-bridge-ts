import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {startRuntimeResident} from '../../../src/runtime/discord-runtime/resident-startup.ts';
import type {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {ResidentStateError} from '../../../src/app-server/resident-state.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';

// The original runtime composition owns the real child and every native adapter.
// No callback substitution or synthetic capability controls capture/admission.
const child=`import readline from 'node:readline';const answers=[],emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.method===undefined&&message.id==='approval'){answers.push(message);return;}if(message.method==='ask')emit({id:'approval',method:'item/tool/requestUserInput',params:{threadId:'T',turnId:'V'}});if(message.id!==undefined)emit({id:message.id,result:message.method==='answers'?answers:{}});});`;
interface Fixture{readonly db:DatabaseSync;readonly owner:PortableResidentLifecycle;call(method:string):Promise<unknown>}
async function fixture(t:TestContext,run:(fixture:Fixture)=>Promise<void>):Promise<void>{
 await storeFixture(async path=>{
  const owner=await startRuntimeResident({process:{executable:process.execPath,arguments:['--no-strip-types','--input-type=module','-e',child],environment:{}},clientInfo:{name:'capture-ordering-fixture',title:'Fixture',version:'965'}},path,'runtime',null,error=>error instanceof Error?error.message:'fixture error',t.signal);
  let db:DatabaseSync|undefined;
  try{
   db=await openInitialized(path);
   db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,'input',0,1,'running',1,'V','[]',1,1)");
   const call=async(method:string)=>{const admission=owner.admitResponse(1n);try{return await admission.client.requestAdmitted(admission.permit,method,{},2000);}finally{admission.release();}};
   await run({db,owner,call});
  }finally{
   try{await owner.dispose();}finally{db?.close();}
   assert.equal(owner.lifecycleSnapshot().processId,null,'original child was joined');
   assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0},'all original native slots released after exit');
  }
 });
}
async function ask(f:Fixture,t:TestContext){
 const receiver=f.owner.subscribeServerRequests();
 try{await f.call('ask');const event=await receiver.receive(t.signal);assert.equal(event.kind,'Request');if(event.kind!=='Request')throw Error('missing original request');return event.request;}
 finally{receiver.dispose();}
}
for(const error of [false,true])for(const changeOwner of [false,true])test(`installed ${error?'error':'result'} response ${changeOwner?'captures original owner before returning its Promise':'accepts its unchanged original owner'}`,{timeout:20000},async t=>fixture(t,async f=>{
 const request=await ask(f,t),payload=error?{id:'approval',error:{code:-7n,message:'declined',data:null}}:{id:'approval',result:{approved:true}};
 const pending=error?f.owner.respondError(request.id,request.occurrence,{code:-7n,message:'declined',data:null},1n):f.owner.respond(request.id,request.occurrence,{approved:true},1n);
 if(changeOwner){
  // Deliberately no await, callback hook or worker barrier between invocation and
  // this same-turn write. A later first capture would silently accept owner 99.
  const changed=f.db.prepare("UPDATE codex_turn_queue SET owner_user_id=99 WHERE job_id='job' AND owner_user_id=3 AND state='running'").run();
  assert.equal(changed.changes,1,'only the original running job changed');
  await assert.rejects(pending,value=>value instanceof ResidentStateError&&value.detail.kind==='MutationHeld'&&value.message.includes('original response custody changed or is held'));
  assert.deepEqual(await f.call('answers'),[],'no original response bytes reached the child');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM cdr_server_responses').get()!.n,0,'refusal created neither admission nor synthetic completion');
  assert.equal(f.db.prepare("SELECT owner_user_id FROM codex_turn_queue WHERE job_id='job'").get()!.owner_user_id,99,'the concurrent authority change was not undone');
 }else{
  await pending;
  assert.deepEqual(await f.call('answers'),[payload]);
  assert.equal(f.db.prepare('SELECT phase FROM cdr_server_responses').get()!.phase,'flushed');
 }
}));
