import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {AdmissionGate,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {recoverStoppedExecution} from '../../../src/runtime/action-executor/stop-recovery.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {getIngressIn} from '../../../src/store/ingress-read.ts';
async function owner(t:TestContext,mode="normal"){
  const script=`import readline from 'node:readline';const mode=${JSON.stringify(mode)};const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=x=>emit({id:m.id,result:x});if(m.method==='initialize')reply({});else if(m.method==='thread/read'){if(mode==='hang'){emit({method:'fixture/read-seen'});return;}reply({thread:{id:m.params.threadId,status:{type:mode==='unloaded'?'notLoaded':'idle'}}});}else if(m.method==='thread/turns/list'){if(mode==='unloaded'&&m.params.itemsView!=='notLoaded'){emit({id:m.id,error:{code:-1,message:'compact required'}});return;}reply({data:mode==='missing'?[]:[{id:'V',status:'completed'}],nextCursor:null});}else if(m.method==='thread/goal/get')reply({goal:null});});`;
  const o=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:["--input-type=module","-e",script],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"1"}},()=>"diagnostic",{persistDeadWork(){},oldChildExited(){}},t.signal,{renderError:e=>e instanceof Error?e.message:"unknown",fence:{requestOrigin:()=>null,checkRequest(){},beginMutationWithOrigin(){throw new Error("Read cannot create mutation claim");},finishMutation(){throw new Error("Read cannot finish mutation claim");}}});t.after(()=>o.dispose());return o;
}

const scope={target:"T",channel:42n,owner:3n},binding={target:"T",route:"Explicit",command:{Stop:{reference:"T"}}};
async function fixture(run:(path:string,db:DatabaseSync)=>void|Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{db.close();}});}
function job(db:DatabaseSync,id="job",status="running",turn:string|null="V"){db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES(?,'T',42,3,7,?, 'original',0,1,?,?,?,'[]',1.25,1.5)").run(id,status==="pending"?null:7,status,status==="pending"?0:1,turn);}
function controlIngress(db:DatabaseSync){db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,source_message_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('message:100','message',100,42,3,100,?,'executing','processing','T',10,11)").run(serializeSerdeValue({version:1n,lifecycle_binding:binding,plan:{Execute:binding.command}}));return getIngressIn(db,"message:100")!;}
function accept(path:string,expected:ReturnType<typeof controlIngress>|null=null,g=7n,check=()=>{}){return state.acceptRunningStop(path,scope,binding,expected,"resident",g,check,()=>50);}

for(const mode of ['success','sealed','restart','aborted','foreign-lease','wrong-target','missing','selected-change','restart-before-commit','seal-before-commit'])test('single original Stop recovery '+mode,{timeout:15000},async t=>{
 const server=await owner(t,mode==='missing'?'missing':'unloaded');
 await fixture(async(path,db)=>{
  job(db);const selected=mode==='selected-change'||mode.endsWith('before-commit');const original=(selected?state.acceptRunningStop(path,scope,{target:'T',route:'Selected',command:{Stop:{reference:null}}},null,'resident',7n,()=>{},()=>50):accept(path))!,gate=new AdmissionGate(),backend=new AppServerTurnBackend(server,()=> 'diagnostic'),queue=new QueueStartCoordinator(path,backend,{admission:gate});
  const registry=mode==='foreign-lease'?new TargetLocks():queue.locks,lease=registry.tryAcquire(mode==='wrong-target'?'other':'T')!;
  const key=DrainFenceKey.create('runtime','1|2','nonce');if(mode==='sealed')gate.seal(key);
  const abort=new AbortController();if(mode==='aborted')abort.abort(new Error('caller stopped'));
  let checks=0;
  // A pending native restart must refuse observation/commit.
  if(mode==='restart'){server.requestRestart();}
  try{
   const run=recoverStoppedExecution(queue,server,lease,original,{selectedThreadId:()=>{checks++;if(checks===2){if(mode==='selected-change')return 'other';if(mode==='restart-before-commit')server.requestRestart();if(mode==='seal-before-commit')gate.seal(key);}return 'T';}},undefined,abort.signal);
   if(mode==='success'){
    assert.equal(await run,1);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,0);
    assert.equal(db.prepare('SELECT phase FROM cdr_stop_controls').get()!.phase,'settled');
   }else{await assert.rejects(run);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,1);assert.equal(db.prepare('SELECT phase FROM cdr_stop_controls').get()!.phase,'accepted');assert.equal(db.prepare('SELECT count(*) AS n FROM codex_request_cancellations').get()!.n,0);}
  }finally{lease.release();}
  assert.equal(queue.locks.activeTargetCount,0);if(!gate.isSealed())gate.seal(key);assert.equal(gate.isDrainedFor(key),true);
 });
});
