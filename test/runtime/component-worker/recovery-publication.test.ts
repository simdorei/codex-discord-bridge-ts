import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {join, dirname, basename} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {work} from '../../helpers/interaction-worker-fixture.ts';
import {AdmissionGate, AdmissionPermit} from '../../../src/admission/drain-gate.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {handleRecoveryPublication} from '../../../src/runtime/component-worker/recovery-publication.ts';
import {isConfirmationPlan} from '../../../src/runtime/component-worker/confirmation.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {enqueueInTransaction} from '../../../src/store/queue-enqueue.ts';
import {proposePublication, bindPublicationDelivery} from '../../../src/store/publication-proposal.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import type {InboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';

const id = 'a'.repeat(32);
function edit<T>(path: string, run: (db: DatabaseSync) => T): T {const db = new DatabaseSync(path); try {return run(db);} finally {db.close();}}
async function fixture(run: (db: string, w: InboundInteractionWork, locks: TargetLocks, verifier: ControlTurnVerifier) => Promise<void>, decision = 'a') {
  await storeFixture(async path => {
    const db = await openInitialized(path);
    try {
      db.exec('BEGIN IMMEDIATE');
      enqueueInTransaction(db, {jobId:'job', targetThreadId:'t', channelId:1n, ownerUserId:2n, discordMessageId:null,
        appServerGeneration:1n, prompt:'prompt', queued:true, ackSent:true, createdAt:1});
      db.exec("INSERT INTO mirror_threads VALUES('t','p','title',10,1,1); COMMIT");
    } finally {db.close();}
    const proposal = await proposePublication(path, {proposal_id:id, job_id:'job', application_id:4n, review_text:'review', review_context:{}, now:10, expires_at:20});
    await bindPublicationDelivery(path, id, 9n, proposal.review_sha256, 11);
    const w = work(path, 5n, new AdmissionGate(), `codex_pub:v1:${id}:1:${decision}`);
    edit(path, handle => handle.prepare(`INSERT INTO discord_ingress_journal
      (ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,created_at,updated_at)
      VALUES(?,'interaction',5,4,1,2,9,?,'runtime','executing','processing','t',11,11)`)
      .run(w.custodyIngressId, serializeSerdeValue({version:1n,work:w.work})));
    const locks = new TargetLocks(), verifier = new ControlTurnVerifier(path, null, {selectedThreadId:()=>null}, locks);
    try {await run(path,w,locks,verifier);} finally {w.admissionPermit!.release();}
  });
}
function call(path: string, w: InboundInteractionWork, verifier: ControlTurnVerifier) {
  assert.ok('Component' in w.work);
  return handleRecoveryPublication(w,w.work.Component,path,verifier,()=>12);
}
const count = (path: string) => edit(path, db => db.prepare('SELECT count(*) AS n FROM cdr_recovery_publication_decisions').get()!.n);

test('both decisions record intent only, mint exact confirmation and leave Pending request intact', async () => {
  for (const decision of ['a','h']) await fixture(async (path,w,locks,v) => {
    const plan = await call(path,w,v);
    assert.equal(isConfirmationPlan(plan),true);
    assert.equal(plan.domain,'recovery-publication-intent-confirmation-v1');
    assert.equal(plan.logicalKey,`${id}:1`);
    assert.equal(plan.content,decision==='a'
      ? 'Exact recovery intent recorded. No request was started; separate safety checks are still required.'
      : 'Recovery will remain held. No request was started.');
    assert.equal(count(path),1);
    assert.equal(edit(path,db=>db.prepare('SELECT state FROM codex_turn_queue').get()!.state),'pending');
    assert.equal(locks.activeTargetCount,0);
    assert.deepEqual(await call(path,w,v),plan);
    assert.equal(count(path),1);
  },decision);
});
test('missing, released and forged admission permits cannot record consent', async () => {
  await fixture(async (path,w,locks,v) => {
    for (const permit of [null,Object.create(AdmissionPermit.prototype) as AdmissionPermit])
      await assert.rejects(call(path,{...w,admissionPermit:permit},v),/matching live admission/);
    w.admissionPermit!.release();
    await assert.rejects(call(path,w,v),/matching live admission/);
    assert.equal(count(path),0); assert.equal(locks.activeTargetCount,0);
  });
});
test('confirmation-only and mismatched routed component cannot record consent',()=>fixture(async(path,w,_locks,v)=>{
  await assert.rejects(call(path,{...w,processingMode:'ConfirmationOnly'},v),/matching live admission/);
  await assert.rejects(handleRecoveryPublication(w,{RecoveryPublicationDecision:{proposal_id:id,revision:2n,decision:'ApproveExact'}},path,v,()=>12),/matching live admission/);
  assert.equal(count(path),0);
}));
test('canonical custody path must identify the same existing database',()=>fixture(async(path,w,_locks,v)=>{
  await storeFixture(async other=>{const db=await openInitialized(other);db.close();await assert.rejects(call(path,{...w,custodyDatabase:other},v),/custody database changed/);});
  assert.equal(count(path),0);
  const equivalent=join(dirname(path),'.',basename(path));
  await call(path,{...w,custodyDatabase:equivalent},v); assert.equal(count(path),1);
}));
test('actor and source message mismatch reject before writing intent',()=>fixture(async(path,w,locks,v)=>{
  for(const changed of [{userId:8n},{applicationId:8n},{channelId:8n},{sourceMessageId:8n}])
    await assert.rejects(call(path,{...w,...changed},v),/delivery identity/);
  await assert.rejects(call(path,{...w,sourceMessageId:null},v),/source Discord message/);
  assert.equal(count(path),0);assert.equal(locks.activeTargetCount,0);
}));
test('durable event and component are rechecked under shared target lock',()=>fixture(async(path,w,locks,v)=>{
  await assert.rejects(call(path,{...w,interactionId:6n},v),/original durable ingress/);
  edit(path,db=>db.prepare('UPDATE discord_ingress_journal SET payload_json=?').run(serializeSerdeValue({version:1n,work:{Component:{RecoveryPublicationDecision:{proposal_id:id,revision:1n,decision:'KeepHeld'}}}})));
  await assert.rejects(call(path,w,v),/original durable ingress/);
  assert.equal(count(path),0);assert.equal(locks.activeTargetCount,0);
}));
test('target timeout never releases another owner and leaves no queued lock or consent',()=>fixture(async(path,w,locks,v)=>{
  const owner=await locks.acquire('t');
  try {await assert.rejects(call(path,w,v),/target is busy/);owner.requireTarget('t');assert.equal(count(path),0);}
  finally {owner.release();}
  assert.equal(locks.activeTargetCount,0);
  await call(path,w,v);assert.equal(count(path),1);
}));
test('consent failure releases target lease and does not mint confirmation',()=>fixture(async(path,w,locks,v)=>{
  edit(path,db=>db.exec("UPDATE codex_turn_queue SET last_error='changed'"));
  await assert.rejects(call(path,w,v),/local evidence changed/);
  assert.equal(count(path),0);assert.equal(locks.activeTargetCount,0);
}));
test('concurrent duplicate clicks serialize to one immutable intent',()=>fixture(async(path,w,locks,v)=>{
  const results=await Promise.all([call(path,w,v),call(path,w,v)]);
  assert.deepEqual(results[0],results[1]);assert.equal(count(path),1);assert.equal(locks.activeTargetCount,0);
}));
