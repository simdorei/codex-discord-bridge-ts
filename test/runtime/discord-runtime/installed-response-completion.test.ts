import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {responseWorkerFixture,responseUntil} from '../../helpers/response-completion-worker-fixture.ts';
import {startRuntimeResident} from '../../../src/runtime/discord-runtime/resident-startup.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {storeAuthorityEnrolled} from '../../../src/store/store-authority-domain.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {AppServerWriter} from '../../../src/app-server/writer.ts';
import {NodeAppServerInput} from '../../../src/app-server/node-streams.ts';
import {isOwnedMutationOutcomeUnknown} from '../../../src/app-server/maintenance-attempt.ts';
import {serializeSerdeValue,sha256SerdeValue} from '../../../src/core/serde-json.ts';
const render=(e:unknown)=>e instanceof Error?e.message:'fixture error';
const code=`import readline from 'node:readline';const answers=[],emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method===undefined&&m.id==='approval'){answers.push(m);return;}if(m.method==='ask')emit({id:'approval',method:'item/tool/requestUserInput',params:{threadId:'T',turnId:'V'}});if(m.id!==undefined)emit({id:m.id,result:m.method==='answers'?answers:{}});});`;
interface Fixture{path:string;db:DatabaseSync;owner:PortableResidentLifecycle;call(method:string):Promise<unknown>}
async function fixture(t:TestContext,run:(f:Fixture)=>Promise<void>){await storeFixture(async path=>{
 t.mock.method(state,'finishResponseCustody',()=>assert.fail('installed path called synchronous finish fallback'));
 const owner=await startRuntimeResident({process:{executable:process.execPath,arguments:['--no-strip-types','--input-type=module','-e',code],environment:{}},clientInfo:{name:'completion-fixture',title:'Fixture',version:'931'}},path,'runtime',null,render);
 const db=await openInitialized(path);const call=async(method:string)=>{const a=owner.admitResponse(1n);try{return await a.client.requestAdmitted(a.permit,method,{},2000);}finally{a.release();}};
 try{db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,'input',0,1,'running',1,'V','[]',1,1)");assert.equal(storeAuthorityEnrolled(path),false);await run({path,db,owner,call});}
 finally{try{await owner.dispose();}finally{db.close();}assert.equal(ownedWorkerUsage().Control,0);assert.equal(storeAuthorityEnrolled(path),false);}
 });}
async function ask(f:Fixture,t:TestContext){const rx=f.owner.subscribeServerRequests();try{await f.call('ask');const event=await rx.receive(t.signal);assert.equal(event.kind,'Request');if(event.kind!=='Request')throw Error('missing request');return event.request;}finally{rx.dispose();}}
for(const error of [false,true])test(`installed ${error?'error':'result'} response retains exact original and uses only native post-flush persistence`,{timeout:20000},async t=>fixture(t,async f=>{
 const request=await ask(f,t),result={approved:true},payload=error?{id:'approval',error:{code:-7n,message:'declined',data:null}}:{id:'approval',result};
 if(error)await f.owner.respondError(request.id,request.occurrence,{code:-7n,message:'declined',data:null},1n);else await f.owner.respond(request.id,request.occurrence,result,1n);
 assert.deepEqual(await f.call('answers'),[payload]);const row=f.db.prepare('SELECT phase,response_sha256,authority_json FROM cdr_server_responses').get()!;assert.equal(row.phase,'flushed');assert.equal(row.response_sha256,sha256SerdeValue(payload));assert.match(row.authority_json as string,RegExp(f.owner.instanceId));
 await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/stale/);assert.deepEqual(await f.call('answers'),[payload]);
}));
test('installed sync admission/final guard refusal emits zero bytes and no completion',{timeout:20000},async t=>fixture(t,async f=>{
 const request=await ask(f,t);f.db.exec("CREATE TRIGGER denied BEFORE INSERT ON cdr_server_responses BEGIN SELECT RAISE(ABORT,'original begin refused'); END");await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/original begin refused/);assert.deepEqual(await f.call('answers'),[]);assert.equal(f.db.prepare('SELECT count(*) AS n FROM cdr_server_responses').get()!.n,0);
}));
test('installed definitive failure after committed preflight and before start completes not_sent',{timeout:20000},async t=>fixture(t,async f=>{
 const request=await ask(f,t),write=AppServerWriter.prototype.write;
 t.mock.method(AppServerWriter.prototype,'write',function(this:AppServerWriter,value:any,preflight:any,started:any,signal:any){return write.call(this,value,value.id==='approval'?{check(){preflight.check();throw Error('fixture pre-start refusal');},dispose:preflight.dispose}:preflight,started,signal);});
 await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),/fixture pre-start refusal/);assert.equal(f.db.prepare('SELECT phase FROM cdr_server_responses').get()!.phase,'not_sent');assert.deepEqual(await f.call('answers'),[]);
}));
test('installed identity-matched cancellation during sync begin preserves the original bypass and admission',{timeout:20000},async t=>{
 const stop=new AbortController(),reason={cancel:'during original begin'},begin=state.beginResponseCustody;
 t.mock.method(state,'beginResponseCustody',(...args:Parameters<typeof begin>)=>{begin(...args);stop.abort(reason);});
 await fixture(t,async f=>{
  const request=await ask(f,t),watch=responseWorkerFixture(f.path);
  try{await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n,stop.signal),e=>e===reason);assert.deepEqual(await f.call('answers'),[]);assert.equal(f.db.prepare('SELECT phase FROM cdr_server_responses').get()!.phase,'admitted');assert.equal(watch.count,0);}
  finally{watch.release();await watch.join();watch.restore();}
 });
});
test('installed failure after actual native response write retains admission with no completion or retry',{timeout:20000},async t=>fixture(t,async f=>{
 const request=await ask(f,t),watch=responseWorkerFixture(f.path),write=NodeAppServerInput.prototype.writeAll;let responses=0;
 t.mock.method(NodeAppServerInput.prototype,'writeAll',async function(this:NodeAppServerInput,bytes:Uint8Array,signal?:AbortSignal){
  await write.call(this,bytes,signal);
  if(Buffer.from(bytes).toString().includes('"id":"approval"')){responses++;throw Error('fixture pipe failure after native write');}
 });
 try{await assert.rejects(f.owner.respond(request.id,request.occurrence,true,1n),isOwnedMutationOutcomeUnknown);assert.equal(responses,1);assert.equal(watch.count,0);assert.equal(f.db.prepare('SELECT phase FROM cdr_server_responses').get()!.phase,'admitted');assert.equal(f.owner.lifecycleSnapshot().healthy,false);}
 finally{watch.release();await watch.join();watch.restore();}
}));
for(const mode of ['ack','drop','foreign','duplicate'] as const)test(`installed ${mode} receipt waits for actual exit; lost/foreign/repeated ACK never retries`,{timeout:20000},async t=>fixture(t,async f=>{
 const request=await ask(f,t),watch=responseWorkerFixture(f.path,mode);let settled=false;
 const pending=f.owner.respond(request.id,request.occurrence,{approved:true},1n);void pending.then(()=>{settled=true;},()=>{settled=true;});
 const checked=mode==='ack'?pending:assert.rejects(pending,isOwnedMutationOutcomeUnknown);
 try{
  await responseUntil(()=>Atomics.load(watch.trace,3)===1,'original completion module committed');assert.equal(Atomics.load(watch.trace,2),1);assert.equal(watch.exited,0);assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);assert.equal(f.db.prepare('SELECT phase FROM cdr_server_responses').get()!.phase,'flushed');assert.deepEqual(await f.call('answers'),[{id:'approval',result:{approved:true}}]);
  const q=watch.submitted as any;assert.equal(q.scope.resident,f.owner.instanceId);assert.equal(q.scope.request.id,request.id);assert.deepEqual(q.scope.request.occurrence,Array.from(request.occurrence.asBytes(),BigInt));assert.equal(serializeSerdeValue(q.payload),serializeSerdeValue({id:'approval',result:{approved:true}}));
  watch.release();await checked;assert.equal(watch.count,1);assert.equal(watch.exited,1);await assert.rejects(f.owner.respond(request.id,request.occurrence,{},1n),/stale/);assert.deepEqual(await f.call('answers'),[{id:'approval',result:{approved:true}}]);
 }finally{watch.release();await Promise.allSettled([pending]);await watch.join();watch.restore();}
}));
test('installed post-flush cancellation stays Unknown and shutdown joins original native exit',{timeout:20000},async t=>fixture(t,async f=>{
 const request=await ask(f,t),watch=responseWorkerFixture(f.path),stop=new AbortController();let settled=false,closed=false;let closing:Promise<void>|undefined;
 const pending=f.owner.respond(request.id,request.occurrence,true,1n,stop.signal),checked=assert.rejects(pending,isOwnedMutationOutcomeUnknown);void pending.then(()=>{settled=true;},()=>{settled=true;});
 try{
  await responseUntil(()=>Atomics.load(watch.trace,3)===1,'completion committed before cancellation');stop.abort(Error('caller left after flush'));closing=f.owner.close();void closing.then(()=>{closed=true;},()=>{closed=true;});await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);assert.equal(closed,false);assert.equal(watch.exited,0);assert.equal(ownedWorkerUsage().Control,1);
  watch.release();await checked;await closing;assert.equal(watch.exited,1);assert.equal(f.owner.lifecycleSnapshot().processId,null);assert.equal(f.db.prepare('SELECT phase FROM cdr_server_responses').get()!.phase,'flushed');
 }finally{watch.release();await Promise.allSettled([pending,...(closing?[closing]:[])]);await watch.join();watch.restore();}
}));
