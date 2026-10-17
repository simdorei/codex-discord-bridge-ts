import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join,relative} from 'node:path';
import {existsSync,readFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {NativeRunnerInspectionReader,NativeRunnerInspectionUnavailable,RUNNER_INSPECTION_OUTPUT_BYTES} from '../../../src/runtime/action-executor/runner-inspection-native.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {InvalidActionRequestError} from '../../../src/runtime/action-executor/errors.ts';
import {boundedSerdeByteCount} from '../../../src/core/serde-byte-count.ts';
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function seed(path:string){const db=await openInitialized(path);try{db.exec(`INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,created_at,updated_at) VALUES('original','message',9007199254740993,9007199254740995,'{"prompt":"literal password token stays","id":9007199254740997,"nested":{"Access_Token":"never-return"}}','held','claimed',0,0)`);}finally{db.close();}}
const channel=9007199254740993n,user=9007199254740995n;
test('four existing-only native operations preserve exact actor integers and only return redacted display',()=>storeFixture(async path=>{
 await seed(path);const before=readFileSync(path),reader=new NativeRunnerInspectionReader(path),detail=await reader.detail(channel,user,'original');assert.match(detail,/9007199254740997/);assert.match(detail,/literal password token stays/);assert.ok(!detail.includes('never-return'));assert.match(await reader.summary(channel,user),/original \| status: saved/);assert.match(await reader.global(),/pending: 0/);assert.match(await reader.targetCounts('target','selected','owned_active_turn: unknown'),/queued: 0/);assert.deepEqual(readFileSync(path),before);assert.equal(ownedWorkerUsage().Background,0);
 const db=new DatabaseSync(path);db.exec("UPDATE discord_ingress_journal SET payload_json='malformed'");db.close();await assert.rejects(reader.detail(channel,user+1n,'original'),InvalidActionRequestError);await assert.rejects(reader.detail(channel+1n,user,'original'),InvalidActionRequestError);await assert.rejects(reader.detail(channel,user,'original'),NativeRunnerInspectionUnavailable);await assert.rejects(reader.summary(channel,user),NativeRunnerInspectionUnavailable);
}));
test('every operation refuses absent and partial schema with no create or repair',()=>storeFixture(async path=>{
 const reader=new NativeRunnerInspectionReader(path),read=()=>[()=>reader.detail(channel,user,'original'),()=>reader.summary(channel,user),()=>reader.global(),()=>reader.targetCounts('t','selected','owned_active_turn: unknown')];
 for(const run of read())await assert.rejects(run(),NativeRunnerInspectionUnavailable);assert.equal(existsSync(path),false);
 const db=new DatabaseSync(path);db.exec('CREATE TABLE discord_ingress_journal(ingress_id TEXT)');db.close();const before=readFileSync(path);for(const run of read())await assert.rejects(run(),NativeRunnerInspectionUnavailable);assert.deepEqual(readFileSync(path),before);
}));
test('passive bounded input and preabort fail before native submission',async t=>storeFixture(async path=>{
 const reader=new NativeRunnerInspectionReader(path);let submissions=0;t.mock.method(OwnedWorkerSlot.prototype,'run',()=>{submissions++;throw new Error('must not submit');});const c=new AbortController(),reason={cancel:true};c.abort(reason);
 await assert.rejects(reader.detail(channel,user,'original',c.signal),e=>e===reason);await assert.rejects(reader.summary(channel,1n<<63n));await assert.rejects(reader.detail(channel,user,'x'.repeat(16385)),RangeError);await assert.rejects(reader.targetCounts('t','s','x'.repeat(16385)),RangeError);await assert.rejects(reader.global(new Proxy(c.signal,{})),TypeError);await assert.rejects(reader.global(undefined,10001),RangeError);assert.equal(submissions,0);assert.equal(existsSync(path),false);
}));
test('bound acknowledgements reject foreign scope, oversize, malformed, passive-accessor and extra-field replies',async t=>storeFixture(async path=>{
 const reader=new NativeRunnerInspectionReader(path);let mode=0,accessed=0;
 t.mock.method(OwnedWorkerSlot.prototype,'run',async(_url:URL,q:Record<string,unknown>)=>{
  const good={...q,ok:true,text:'display'};
  if(mode===0)return {...good,channel:channel+1n};if(mode===1)return {...good,user:user+1n};if(mode===2)return {...good,path:path+'.other'};if(mode===3)return {...good,requestId:'other'};if(mode===4)return {...good,operation:'Global'};if(mode===5)return {...good,id:'foreign'};if(mode===6)return {...good,text:'x'.repeat(RUNNER_INSPECTION_OUTPUT_BYTES+1)};if(mode===7)return {...good,text:'\uD800'};if(mode===8)return {...good,payload:'must not cross'};if(mode===9)return {...good,get text(){accessed++;return 'display';}};return {...q,ok:false,error:'Missing'};
 });
 for(mode=0;mode<10;mode++)await assert.rejects(reader.detail(channel,user,'original'),NativeRunnerInspectionUnavailable);assert.equal(accessed,0);mode=10;await assert.rejects(reader.summary(channel,user),NativeRunnerInspectionUnavailable);await assert.rejects(reader.detail(channel,user,'original'),InvalidActionRequestError);
}));
test('shared owner and Background3 saturation refuse immediately without a waiting queue then recover',()=>storeFixture(async path=>{
 await seed(path);const db=new DatabaseSync(path),readers=Array.from({length:4},()=>new NativeRunnerInspectionReader(path)),tasks:Promise<string>[]=[];
 try{db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');for(const reader of readers.slice(0,3)){const p=reader.global();void p.catch(()=>{});tasks.push(p);}assert.equal(ownedWorkerUsage().Background,3);assert.equal(ownedWorkerUsage().Control,0);await assert.rejects(readers[0]!.summary(channel,user),OwnedWorkerBusyError);await assert.rejects(readers[3]!.detail(channel,user,'original'),OwnedWorkerBudgetError);db.exec('ROLLBACK');await Promise.all(tasks);assert.equal(ownedWorkerUsage().Background,0);assert.match(await readers[3]!.detail(channel,user,'original'),/Saved Discord request/);}
 finally{if(db.isTransaction)db.exec('ROLLBACK');await Promise.allSettled(tasks);db.close();}
}));
test('postsubmit abort and deadline join actual SQLite exit, reject late success, and leave the main event loop live',()=>storeFixture(async path=>{
 await seed(path);const reader=new NativeRunnerInspectionReader(path),db=new DatabaseSync(path);let ticks=0;const timer=setInterval(()=>ticks++,2);
 try{for(const abort of [true,false]){db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const c=new AbortController(),reason={originalAbort:true},task=reader.global(c.signal,abort?6000:1);let finished=false;void task.then(()=>{finished=true;},()=>{finished=true;});const rejected=assert.rejects(task,abort?(e:unknown)=>e===reason:NativeRunnerInspectionUnavailable);if(abort)c.abort(reason);await wait(40);assert.equal(finished,false);assert.equal(ownedWorkerUsage().Background,1);await assert.rejects(reader.summary(channel,user),OwnedWorkerBusyError);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Background,0);assert.match(await reader.global(),/Codex runners/);}assert.ok(ticks>4);}
 finally{clearInterval(timer);if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}));
test('captured relative path and native symlink parent spelling select the original existing database',()=>storeFixture(async path=>{
 const dir=dirname(path),real=join(dir,'real'),child=join(real,'child');mkdirSync(child,{recursive:true});symlinkSync(child,join(dir,'link'),process.platform==='win32'?'junction':'dir');const actual=join(real,'store.sqlite');await seed(actual);if(process.platform==='win32')await seed(path);const reader=new NativeRunnerInspectionReader(join(dir,'link')+'/../store.sqlite');assert.match(await reader.detail(channel,user,'original'),/Saved Discord request/);assert.equal(existsSync(path),process.platform==='win32');
 const prior=process.cwd();try{process.chdir(dir);const pinned=new NativeRunnerInspectionReader(relative(dir,actual));process.chdir('/');assert.match(await pinned.detail(channel,user,'original'),/Saved Discord request/);}finally{process.chdir(prior);}
 assert.throws(()=>reader.assertPath(path),/another database/);
}));

test('actual native pretty expansion and global display overflow fail wholly without releasing or mutating records',()=>storeFixture(async path=>{
 await seed(path);const db=new DatabaseSync(path),reader=new NativeRunnerInspectionReader(path);
 try{const compact='['.repeat(100)+'['+'0,'.repeat(6000)+'0]'+']'.repeat(100);assert.ok(Buffer.byteLength(compact)<16384);db.prepare('UPDATE discord_ingress_journal SET payload_json=?').run(compact);}
 finally{db.close();}
 const before=readFileSync(path);await assert.rejects(reader.detail(channel,user,'original'),NativeRunnerInspectionUnavailable);assert.match(await reader.summary(channel,user),/original \| status: saved/);assert.deepEqual(readFileSync(path),before);
 const change=new DatabaseSync(path);try{for(const id of ['a','b']){change.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES(?,'t',1,'p',0,0,'pending',0,'[]',0,0)").run(id);change.prepare("INSERT INTO cdr_execution_holds VALUES(?,'t',?,'{}',0)").run(id,'x'.repeat(600000));}}finally{change.close();}
 const held=readFileSync(path);await assert.rejects(reader.global(),NativeRunnerInspectionUnavailable);assert.deepEqual(readFileSync(path),held);assert.equal(ownedWorkerUsage().Background,0);
}));


test('exact serialized request and maximum escaped acknowledgement stay bounded, one request byte over never submits',async t=>storeFixture(async path=>{
 const reader=new NativeRunnerInspectionReader(path),limit=128*1024,source='\0'.repeat(16384),base=boundedSerdeByteCount({id:'0'.repeat(36),path,operation:'TargetCounts',channel:null,user:null,requestId:null,target:'t',source:'',owned:''},limit)!;
 const remaining=limit-base-source.length*6,owned='\0'.repeat(Math.floor(remaining/6))+'x'.repeat(remaining%6),output='\0'.repeat(RUNNER_INSPECTION_OUTPUT_BYTES);let submissions=0;
 assert.ok(Buffer.byteLength(owned)<16384);
 t.mock.method(OwnedWorkerSlot.prototype,'run',async(_url:URL,q:Record<string,unknown>)=>{submissions++;assert.equal(boundedSerdeByteCount(q,limit),limit);return {...q,ok:true,text:output};});
 assert.equal(await reader.targetCounts('t',source,owned),output);await assert.rejects(reader.targetCounts('t',source,owned+'x'),/request exceeds native boundary/);assert.equal(submissions,1);
}));
