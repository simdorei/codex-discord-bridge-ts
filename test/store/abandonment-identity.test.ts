import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readAbandonmentRuntimeIn,verifyAbandonmentMessageIn,verifyAbandonmentClickIn} from '../../src/store/abandonment-identity.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
import type {StoredAbandonmentProposal} from '../../src/store/abandonment-codec.ts';
const target={job:'job',thread:'thread',owner:2n,channel:3n};
const stored:StoredAbandonmentProposal={version:1n,proposal:{id:'a'.repeat(32),revision:1n,job_id:'job',thread_id:'thread',owner_user_id:2n,channel_id:3n,
  application_id:4n,created_at_bits:0n,expires_at_bits:0n,review_text:'review',review_sha256:'b'.repeat(64)},source_ingress:'message:5',snapshot:{context:{runtime:{app:'app',wire:'wire'}}}};
const message=()=>({version:1n,content:'!discard-request job',author_is_bot:false,plan:{Execute:{DiscardRequest:{job_id:'job'}}}});
const work=()=>({Component:{RecoveryAbandonDecision:{proposal_id:stored.proposal.id,revision:1n,decision:'AbandonOnly'}}});
const click=()=>({version:1n,work:work()});
// Deliberately minimal read fixtures permit corrupt states; these are not full
// migration/schema or production reachability assertions.
function fixture(run:(db:DatabaseSync)=>void){const db=new DatabaseSync(':memory:');try{
  db.exec(`CREATE TABLE discord_ingress_journal(ingress_id TEXT,version INTEGER,kind TEXT,event_id INTEGER,application_id INTEGER,
    channel_id INTEGER,owner_user_id INTEGER,source_message_id INTEGER,runtime_id TEXT,state TEXT,phase TEXT,target_thread_id TEXT,
    owner_kind TEXT,owner_id TEXT,created_at REAL,payload_json TEXT);
    CREATE TABLE codex_app_server_runtime(singleton INTEGER,runtime_id TEXT);
    CREATE TABLE codex_mutation_runtime(singleton INTEGER,runtime_id TEXT);
    INSERT INTO codex_app_server_runtime VALUES(1,'app');INSERT INTO codex_mutation_runtime VALUES(1,'wire');
    CREATE TABLE cdr_recovery_abandonment_deliveries(proposal_id TEXT,revision INTEGER,message_id INTEGER,body_sha256 TEXT);
    CREATE TABLE cdr_recovery_abandonment_decisions(proposal_id TEXT,ingress_id TEXT,interaction_id INTEGER);`);
  db.prepare('INSERT INTO cdr_recovery_abandonment_deliveries VALUES(?,1,9,?)').run(stored.proposal.id,stored.proposal.review_sha256);
  db.prepare("INSERT INTO discord_ingress_journal VALUES('message:5',1,'message',5,NULL,3,2,5,'app','executing','processing','thread',NULL,NULL,11,?)").run(serializeSerdeValue(message()));
  db.prepare("INSERT INTO discord_ingress_journal VALUES('interaction:6',1,'interaction',6,4,3,2,9,'app','executing','processing','thread',NULL,NULL,12,?)").run(serializeSerdeValue(click()));
  run(db);
}finally{db.close();}}
const verifyMessage=(db:DatabaseSync,fresh=true)=>verifyAbandonmentMessageIn(db,target,'message:5',fresh);
const verifyClick=(db:DatabaseSync,fresh=true)=>verifyAbandonmentClickIn(db,stored,'interaction:6','AbandonOnly',fresh);
const setPayload=(db:DatabaseSync,id:string,value:unknown)=>db.prepare('UPDATE discord_ingress_journal SET payload_json=? WHERE ingress_id=?').run(serializeSerdeValue(value),id);

test('runtime identities are exact strings and borrowed query-only reads leave transactions owned by caller',()=>fixture(db=>{
  db.exec('BEGIN; PRAGMA query_only=ON');assert.deepEqual(readAbandonmentRuntimeIn(db),{app:'app',wire:'wire'});
  const evidence=verifyMessage(db) as Record<string,unknown>;assert.equal(evidence.event,5n);assert.ok(Object.isFrozen(evidence));
  assert.equal(verifyClick(db),6n);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.equal(db.isTransaction,false);
}));
test('runtime missing, blank Rust whitespace and invalid UTF-8 fail closed',()=>{
  for(const sql of ["DELETE FROM codex_mutation_runtime","UPDATE codex_app_server_runtime SET runtime_id=' '","UPDATE codex_mutation_runtime SET runtime_id=char(133)","UPDATE codex_app_server_runtime SET runtime_id=CAST(x'ff' AS TEXT)"])
    fixture(db=>{db.exec(sql);assert.throws(()=>readAbandonmentRuntimeIn(db));});
});
test('message split uses Rust whitespace including NEL and does not trim BOM',()=>fixture(db=>{
  setPayload(db,'message:5',{...message(),content:'\u0085!discard-request\u0085job\n'});assert.doesNotThrow(()=>verifyMessage(db));
  for(const content of ['\ufeff!discard-request job','!discard-request other','!discard-request job extra']){
    setPayload(db,'message:5',{...message(),content});assert.throws(()=>verifyMessage(db),/exact authenticated owner/);
  }
}));
test('message checks stored actor, IDs, target, runtime and unowned custody',()=>{
  for(const sql of ["kind='interaction'","application_id=4","event_id=NULL","event_id=0","source_message_id=7","channel_id=8","owner_user_id=8","target_thread_id='other'","runtime_id='other'","owner_kind='job'","owner_id='job'"])
    fixture(db=>{db.exec("UPDATE discord_ingress_journal SET "+sql+" WHERE ingress_id='message:5'");assert.throws(()=>verifyMessage(db));});
});
test('message payload requires exact command plan and non-bot integer-version identity',()=>{
  for(const payload of [{...message(),version:1},{...message(),author_is_bot:true},{...message(),content:null},{...message(),plan:{Execute:{DiscardRequest:{job_id:'other'}}}}])
    fixture(db=>{setPayload(db,'message:5',payload);assert.throws(()=>verifyMessage(db));});
});
test('historical message retains identity but can omit current processing requirement',()=>fixture(db=>{
  db.exec("UPDATE discord_ingress_journal SET state='completed',phase='done' WHERE ingress_id='message:5'");
  assert.throws(()=>verifyMessage(db),/processing custody/);assert.doesNotThrow(()=>verifyMessage(db,false));
}));
test('click admits only exact historical or complete normal envelopes',()=>fixture(db=>{
  assert.equal(verifyClick(db),6n);
  setPayload(db,'interaction:6',{version:1n,processing_mode:'normal',work:work(),settings_binding:null,request_rejection:null});assert.equal(verifyClick(db),6n);
  for(const payload of [{...click(),extra:true},{...click(),processing_mode:'normal'},
    {version:1n,processing_mode:'normal',work:work(),settings_binding:{},request_rejection:null}]){
    setPayload(db,'interaction:6',payload);assert.throws(()=>verifyClick(db),/displayed abandonment/);
  }
}));
test('click requires exact actor and delivered proposal revision/body/message',()=>{
  for(const sql of ["kind='message'","application_id=8","channel_id=8","owner_user_id=8","source_message_id=8","target_thread_id='other'","runtime_id='other'"])
    fixture(db=>{db.exec("UPDATE discord_ingress_journal SET "+sql+" WHERE ingress_id='interaction:6'");assert.throws(()=>verifyClick(db));});
  for(const sql of ["revision=2","message_id=0","body_sha256='wrong'"])
    fixture(db=>{db.exec('UPDATE cdr_recovery_abandonment_deliveries SET '+sql);assert.throws(()=>verifyClick(db));});
});
test('fresh click checks current runtime and execution; historical click uses original identity',()=>fixture(db=>{
  db.exec("UPDATE discord_ingress_journal SET state='completed',phase='done' WHERE ingress_id='interaction:6'; UPDATE codex_mutation_runtime SET runtime_id='new-wire'");
  assert.throws(()=>verifyClick(db),/processing custody/);assert.equal(verifyClick(db,false),6n);
  db.exec("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id='interaction:6'");
  assert.throws(()=>verifyClick(db),/runtime changed/);assert.equal(verifyClick(db,false),6n);
}));
test('fresh click rejects cross-proposal reuse of either ingress or event ID',()=>{
  for(const [ingress,event] of [['interaction:6',99n],['other',6n]] as const)fixture(db=>{
    db.prepare('INSERT INTO cdr_recovery_abandonment_decisions VALUES(?,?,?)').run('c'.repeat(32),ingress,event);
    assert.throws(()=>verifyClick(db),/already consumed elsewhere/);assert.equal(verifyClick(db,false),6n);
  });
});
test('missing, oversized, malformed payload and unsupported saved timestamp/version reject',()=>{
  for(const sql of ["payload_json='{'","payload_json=printf('%.*c',131073,'x')","created_at=-1","created_at=1e999","version=2"])
    fixture(db=>{db.exec("UPDATE discord_ingress_journal SET "+sql+" WHERE ingress_id='interaction:6'");assert.throws(()=>verifyClick(db));});
  fixture(db=>{db.exec("DELETE FROM discord_ingress_journal WHERE ingress_id='interaction:6'");assert.throws(()=>verifyClick(db));});
});
