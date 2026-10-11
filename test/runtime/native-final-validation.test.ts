import test from 'node:test';import assert from 'node:assert/strict';import {existsSync,readFileSync} from 'node:fs';import type {DatabaseSync} from 'node:sqlite';
import {NativeMutationOwner} from '../../src/runtime/native-mutation-owner.ts';import {createMutationCustodyFence} from '../../src/runtime/mutation-custody-fence.ts';import type {MaintenanceClaim} from '../../src/app-server/maintenance-attempt.ts';import {PortableAppServerSession} from '../../src/app-server/portable-session.ts';import {StateAccessFacade} from '../../src/store/state-access-facade.ts';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {selectJob,serializeStoredQueueJob} from '../../src/store/queue-read.ts';import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';import {serializeSerdeValue} from '../../src/core/serde-json.ts';import {claimStopControl} from '../../src/store/stop-control-dispatch.ts';
async function fixture(run:(path:string,db:DatabaseSync,owner:NativeMutationOwner,c:MaintenanceClaim)=>Promise<void>){await storeFixture(async path=>{
 const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime'); INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");const owner=new NativeMutationOwner(path,'runtime',x=>'safe: '+x),origin=createMutationCustodyFence(path,'runtime',()=> 'safe').requestOrigin('thread/resume',{threadId:'T'}),c:MaintenanceClaim={ownerId:'resident',generation:1n,attemptId:'attempt',wire:'wire',method:'thread/resume',params:{threadId:'T'},scoped:true,origin};
 try{await run(path,db,owner,c);}finally{await owner.close();db.close();}
});}
function queue(db:DatabaseSync){db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,1,'input',0,1,'starting',1,'[]',1,1)");return parseSerdeValue(serializeStoredQueueJob(selectJob(db,'job')));}
const stopSql="UPDATE cdr_stop_clock SET revision=1; INSERT INTO cdr_stop_revision_receipts VALUES('stop','T',1,'{}'); INSERT INTO cdr_stop_revisions VALUES('T',1,'stop')";
test('exact owned native receipt validates without clearing intent; copied and consumed receipts cannot validate',async()=>fixture(async(_p,db,o,c)=>{
 const r=await o.begin(c);o.validateForDispatch(r);assert.equal(db.prepare('SELECT state FROM codex_mutation_attempts').get()!.state,'prepared');assert.throws(()=>o.validateForDispatch({...r}),/unused receipt/);await o.finish(r,'not_sent');assert.throws(()=>o.validateForDispatch(r),/unused receipt/);
}));
test('closed owner and another owner cannot reuse a previously committed original receipt',async()=>fixture(async(p,_db,o,c)=>{
 const r=await o.begin(c),other=new NativeMutationOwner(p,'runtime',x=>x);try{assert.throws(()=>other.validateForDispatch(r),/unused receipt/);}finally{await other.close();}await o.close();assert.throws(()=>o.validateForDispatch(r),/closed/);
}));
test('original queue claim is revalidated after native completion, never recaptured',async()=>fixture(async(_p,db,o,c)=>{
 const claim=queue(db),r=await o.beginQueue({ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wire:c.wire,method:'turn/start',params:c.params,claim});o.validateForDispatch(r);db.exec('UPDATE codex_turn_queue SET owner_user_id=99');assert.throws(()=>o.validateForDispatch(r),/original queue start authority/);assert.equal(db.prepare('SELECT state FROM codex_mutation_attempts').get()!.state,'prepared');
}));
for(const [name,sql] of [
 ['new stop revision',stopSql],
 ['runtime replacement',"UPDATE codex_mutation_runtime SET runtime_id='new'"],
 ['target dead generation',"INSERT INTO codex_dead_generation_holds VALUES('T','runtime',1,0)"],
 ['generation seal',"INSERT INTO codex_dead_generation_incidents VALUES('runtime',1,'{}','[]',0)"],
 ['response hold',"INSERT INTO cdr_server_responses(request_key,runtime_id,resident_owner,generation,target_thread_id,turn_id,job_id,authority_json,response_sha256,phase,created_at,updated_at) VALUES('r','runtime','resident',1,'T','V','job','{}','hash','admitted',0,0)"],
 ['original wire changed',"UPDATE codex_mutation_attempts SET wire_id='changed'"],
] as const)test('final native receipt read refuses '+name,async()=>fixture(async(_p,db,o,c)=>{const r=await o.begin(c);db.exec(sql);assert.throws(()=>o.validateForDispatch(r));assert.equal(db.prepare('SELECT state FROM codex_mutation_attempts').get()!.state,'prepared');}));
test('final read operation is pinned before native wait despite later facade property replacement',async()=>fixture(async(_p,_db,o,c)=>{
 const r=await o.begin(c),old=StateAccessFacade.revalidatePreparedMutation;let calls=0;Object.defineProperty(StateAccessFacade,'revalidatePreparedMutation',{value:()=>{calls++;throw Error('substituted');},writable:true,configurable:true,enumerable:true});try{o.validateForDispatch(r);assert.equal(calls,0);}finally{Object.defineProperty(StateAccessFacade,'revalidatePreparedMutation',{value:old,writable:true,configurable:true,enumerable:true});}
}));
test('busy owner cannot validate another receipt while an accepted native operation runs',async()=>fixture(async(_p,_db,o,c)=>{
 const r=await o.begin(c),pending=o.begin({...c,attemptId:'other',params:{threadId:'other'},origin:{target:'other',stopRevision:0n}});assert.throws(()=>o.validateForDispatch(r));await pending;o.validateForDispatch(r);
}));
test('accepted stop uses exact original token, wire and job; it never substitutes ordinary prepared evidence',async()=>{
 for(const drift of [null,"UPDATE cdr_stop_controls SET wire_id='other'","UPDATE cdr_stop_controls SET claim_token='other'","UPDATE codex_turn_queue SET owner_user_id=99","UPDATE codex_mutation_runtime SET runtime_id='new'"])await fixture(async(path,db,o,c)=>{
  queue(db);db.exec("INSERT INTO codex_mutation_attempts(attempt_id,runtime_id,owner_id,generation,wire_id,method,target_thread_id,scoped,request_sha256,state,created_at,updated_at) VALUES('held','runtime','resident',1,'old','turn/start','T',1,'hash','prepared',0,0); UPDATE codex_turn_queue SET state='running',turn_id='V',turn_observation_generation=1; INSERT INTO cdr_execution_holds VALUES('job','T','stop','{}',0)");
  const control={operation_id:'stop-original',target:'T',channel:42n,owner:3n,resident:'resident',generation:1n,turn:'V',binding:{target:'T',route:'Selected',command:{Stop:{reference:null}}},jobs:[serializeStoredQueueJob(selectJob(db,'job'))],can_settle:true};const json=`{${Object.entries(control).map(([k,v])=>`${JSON.stringify(k)}:${serializeSerdeValue(v)}`).join(',')}}`;
  db.prepare("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES('stop-original','T','resident',1,'V',?,'accepted')").run(json);const claim=claimStopControl(path,control,()=>{})!,r=await o.beginStop({ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wire:c.wire,params:{threadId:'T',turnId:'V'},claim});
  o.validateForDispatch(r);if(drift){db.exec(drift);assert.throws(()=>o.validateForDispatch(r));}else{await o.finish(r,'reply_ok');assert.throws(()=>o.validateForDispatch(r),/unused receipt/);}assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_execution_holds').get()!.n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_mutation_attempts').get()!.n,1);
 });
});
for(const drift of [false,true])test('actual owned session '+(drift?'rejects changed queue and sends zero frames':'sends one frame only after exact original final read'),async()=>fixture(async(path,db,o,c)=>{
 const claim=queue(db),log=path+'.wire',code=`import readline from 'node:readline';import {appendFileSync} from 'node:fs';readline.createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.method==='initialized')return;if(m.method==='turn/start')appendFileSync(${JSON.stringify(log)},s+'\\n');process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});`;
 const {session}=await PortableAppServerSession.startObserved({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'fixture',title:'Fixture',version:'1'}},()=>({value:null,dispose(){}}),()=> 'safe'),port=session.residentClient(),permit=port.admitOperation();let receipt:Awaited<ReturnType<NativeMutationOwner['beginQueue']>>|undefined,disposed=0;
 try{const pending=port.requestAdmittedWithOwnedPreflight!(permit,'turn/start',{threadId:'T'},5000,{
  check:async wire=>{receipt=await o.beginQueue({ownerId:c.ownerId,generation:c.generation,attemptId:c.attemptId,wire,method:'turn/start',params:{threadId:'T'},claim});if(drift)db.exec('UPDATE codex_turn_queue SET owner_user_id=99');return receipt;},
  validate:r=>{o.validateForDispatch(r);port.requireOwnedAdmission(permit);},dispose:async r=>{disposed++;await o.finish(r,'not_sent');},writeStarted(){},writeComplete(){},
 });if(drift)await assert.rejects(pending,/original queue start authority/);else{await pending;await o.finish(receipt!,'reply_ok');}
 const frames=existsSync(log)?readFileSync(log,'utf8').trim().split('\n').length:0;assert.equal(frames,drift?0:1);assert.equal(disposed,drift?1:0);assert.equal(db.prepare('SELECT state FROM codex_mutation_attempts').get()!.state,drift?'not_sent':'reply_ok');
 }finally{permit.release();await session.dispose();}
}));
