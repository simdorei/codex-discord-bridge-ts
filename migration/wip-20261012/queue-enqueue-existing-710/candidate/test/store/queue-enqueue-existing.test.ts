import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';import {queueJob} from '../helpers/queue-job.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {enqueue,enqueueExisting,enqueueIfMirrorMatches,enqueueIfMirrorMatchesExisting,MirrorMappingChangedError,snapshotNewQueueJob,type QueueEnqueueResult} from '../../src/store/queue-enqueue.ts';
async function db<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const c=await openInitialized(path);try{return run(c);}finally{c.close();}}
const job=()=>queueJob({channelId:9007199254740995n,ownerUserId:7n,discordMessageId:9n,prompt:'한글😀',createdAt:1234.5});
const mapping={discordChannelId:9007199254740995n,targetThreadId:'target'};
const idle="INSERT INTO cdr_idle_release VALUES ('intent','owner',1,'target','turn','old-job',7,'Candidate','old')";
test('existing enqueue pairs full inserted and duplicate-message results with original initialized entry',async()=>{
 const pairs:QueueEnqueueResult[][]=[];
 for(const existing of [false,true])await storeFixture(async path=>{await db(path,()=>{});const run=existing?enqueueExisting:enqueue,first=await run(path,job()),second=await run(path,{...job(),jobId:'different',prompt:'not overwrite'});assert.equal(first.created,true);assert.equal(second.created,false);assert.deepEqual(second.job,first.job);assert.equal(first.job.attemptCount,0n);assert.equal(first.job.channelId,9007199254740995n);pairs.push([first,second]);});assert.deepEqual(pairs[0],pairs[1]);
});
test('existing mirror admission preserves exact mapping and returns original typed mismatch before idle effects',async()=>{
 for(const existing of [false,true])await storeFixture(async path=>{await db(path,c=>c.exec(idle));const run=existing?enqueueIfMirrorMatchesExisting:enqueueIfMirrorMatches;await assert.rejects(async()=>run(path,job(),mapping),(e:unknown)=>e instanceof MirrorMappingChangedError&&e.discordChannelId===mapping.discordChannelId&&e.expectedTargetThreadId==='target'&&e.actualTargetThreadId===null);await db(path,c=>{assert.equal(c.prepare('SELECT state FROM cdr_idle_release').get()!.state,'Candidate');assert.equal(c.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,0);c.prepare("INSERT INTO mirror_threads VALUES ('target','p','title',1,?,0)").run(mapping.discordChannelId);});assert.equal((await run(path,job(),mapping)).created,true);await db(path,c=>assert.equal(c.prepare('SELECT state FROM cdr_idle_release').get()!.state,'Settled'));});
});
test('existing enqueue rolls back tentative idle cancellation when original Stop custody refuses',async()=>{
 for(const existing of [false,true])await storeFixture(async path=>{await db(path,c=>{c.exec(idle);c.prepare("INSERT INTO discord_ingress_journal (ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,outcome_json,created_at,updated_at) VALUES ('message:9','message',9,1,7,'{}','held','staged','{\"stop_hold\":null}',0,0)").run();});await assert.rejects(async()=>(existing?enqueueExisting:enqueue)(path,job()),/stop custody differs/);await db(path,c=>{assert.equal(c.prepare('SELECT state FROM cdr_idle_release').get()!.state,'Candidate');assert.equal(c.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,0);assert.equal(c.prepare('SELECT outcome_json FROM discord_ingress_journal').get()!.outcome_json,'{"stop_hold":null}');});});
});
test('existing enqueue preserves original lazy fork table and legacy index retirement',async()=>{
 const {ensureForkHandoffTable}=await import('../../src/store/fork-handoff-admission.ts');
 for(const existing of [false,true])await storeFixture(async path=>{
  await db(path,c=>{ensureForkHandoffTable(c);c.exec('CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs(observed_target_thread_id)');});await (existing?enqueueExisting:enqueue)(path,job());
  const {openExisting}=await import('../../src/store/existing-store.ts'),c=openExisting(path);try{assert.equal(c.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='index' AND name='codex_thread_fork_handoffs_observed_target'").get()!.n,0);assert.equal(c.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name='codex_thread_fork_handoffs'").get()!.n,1);}finally{c.close();}
 });
});
test('existing enqueue refuses incompatible catalog without recreating missing schema or touching idle custody',async()=>storeFixture(async path=>{
 await db(path,c=>{c.exec(idle);c.exec('DROP INDEX codex_prompt_intakes_message_id');});assert.throws(()=>enqueueExisting(path,job()));
 const {openExisting}=await import('../../src/store/existing-store.ts'),c=openExisting(path);try{assert.equal(c.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='codex_prompt_intakes_message_id'").get()!.n,0);assert.equal(c.prepare('SELECT state FROM cdr_idle_release').get()!.state,'Candidate');assert.equal(c.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,0);}finally{c.close();}
}));
test('existing enqueue full-row decode failure rolls back insertion and original idle mutation together',async()=>{
 for(const existing of [false,true])await storeFixture(async path=>{await db(path,c=>{c.exec(idle);c.exec("CREATE TRIGGER invalid_queue AFTER INSERT ON codex_turn_queue BEGIN UPDATE codex_turn_queue SET prompt=CAST(X'80' AS TEXT) WHERE job_id=NEW.job_id; END");});await assert.rejects(async()=>(existing?enqueueExisting:enqueue)(path,job()));await db(path,c=>{assert.equal(c.prepare('SELECT count(*) AS n FROM codex_turn_queue').get()!.n,0);assert.equal(c.prepare('SELECT state FROM cdr_idle_release').get()!.state,'Candidate');});});
});
test('existing enqueue validates passive input and refuses missing database without creation',async()=>storeFixture(async path=>{
 let hooks=0;const bad=Object.defineProperty(job(),'prompt',{get(){hooks++;return 'bad';},enumerable:true});assert.throws(()=>enqueueExisting(path,bad),TypeError);assert.throws(()=>enqueueExisting(path,new Proxy(job(),{get(){hooks++;throw Error('trap');}})),TypeError);assert.throws(()=>enqueueIfMirrorMatchesExisting(path,job(),Object.defineProperty({...mapping},'targetThreadId',{get(){hooks++;return 'bad';},enumerable:true})),TypeError);assert.equal(hooks,0);assert.equal(existsSync(path),false);assert.throws(()=>enqueueExisting(path,job()));assert.equal(existsSync(path),false);
}));

test('enqueue snapshots reject inherited descriptor value without invoking hooks',()=>{
 const input=Object.defineProperty(job(),'prompt',{get(){throw Error('input getter must not run');},enumerable:true});
 const before=Object.getOwnPropertyDescriptor(Object.prototype,'value');let hooks=0,failed:unknown;
 const descriptor=Object.create(null) as PropertyDescriptor;descriptor.configurable=true;descriptor.get=()=>{hooks++;return 'forged';};
 try{Object.defineProperty(Object.prototype,'value',descriptor);try{snapshotNewQueueJob(input);}catch(error){failed=error;}}
 finally{if(before)Object.defineProperty(Object.prototype,'value',before);else delete (Object.prototype as {value?:unknown}).value;}
 assert.equal(hooks,0);assert.ok(failed instanceof TypeError);
});
