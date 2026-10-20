import assert from "node:assert/strict";
import {test} from "node:test";
import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {recordNewAdmissionIn,verifyRecordedAdmissionIn,type RecordedAdmission} from "../../src/store/ingress-admission-order.ts";
import type {NewIngress} from "../../src/store/ingress-types.ts";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
const request=(overrides:Partial<NewIngress>={}):NewIngress=>({ingressId:"original",kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{a:1n},targetThreadId:"target",canonicalOwner:null,now:0,...overrides});
async function withDb(run:(db:DatabaseSync)=>void):Promise<void>{await storeFixture(async path=>{const db=await openInitialized(path);try{run(db);}finally{db.close();}});}
function insert(db:DatabaseSync,r:NewIngress,runtime:string|null=null):void{
  db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,canonical_owner,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'staged','staged',?,?,?,?)`).run(r.ingressId,r.kind,r.eventId,r.applicationId,r.channelId,r.ownerUserId,r.sourceMessageId,serializeSerdeValue(r.payload),runtime,r.targetThreadId,r.canonicalOwner,r.now,r.now);
}
function counts(db:DatabaseSync):unknown[]{return [db.prepare("SELECT count(*) AS n FROM discord_ingress_journal").get()?.n,db.prepare("SELECT count(*) AS n FROM cdr_recovery_ingress_order").get()?.n];}
test("original admission ordinal binds declaration-order digest and normalizes SQLite negative zero",async()=>{
  await withDb(db=>{db.exec("BEGIN IMMEDIATE");const r=request({now:-0});insert(db,r);const proof=recordNewAdmissionIn(db,r,null);verifyRecordedAdmissionIn(db,proof);
    const expected='{"version":1,"kind":"message","event_id":3,"application_id":null,"channel_id":1,"owner_user_id":2,"source_message_id":null,"payload_json":"{\\"a\\":1}","runtime_id":null,"target_thread_id":"target","canonical_owner":null,"created_at_bits":0}';
    const ordinal=db.prepare("SELECT * FROM cdr_recovery_ingress_order").get()!;assert.equal(ordinal.identity_sha256,createHash("sha256").update(expected).digest("hex"));assert.equal(ordinal.sequence,1);assert.equal(ordinal.origin,"admitted");
    assert.equal(Object.isFrozen(proof),true);assert.deepEqual(Object.keys(proof),[]);db.exec("COMMIT");assert.throws(()=>verifyRecordedAdmissionIn(db,proof),/active transaction/);
  });
});
test("admission order refuses mismatched original identity before inserting an ordinal",async()=>{
  const changes:Partial<NewIngress>[]=[{kind:"action"},{eventId:4n},{applicationId:5n},{channelId:9n},{ownerUserId:9n},{sourceMessageId:6n},{payload:{a:2n}},{targetThreadId:"other"},{canonicalOwner:"owner"},{now:1}];
  for(const change of changes)await withDb(db=>{db.exec("BEGIN IMMEDIATE");insert(db,request());assert.throws(()=>recordNewAdmissionIn(db,request(change),null),/differs from admission/);assert.deepEqual(counts(db),[1,0]);db.exec("ROLLBACK");});
  await withDb(db=>{db.exec("BEGIN IMMEDIATE");insert(db,request(),"resident");assert.throws(()=>recordNewAdmissionIn(db,request(),null),/differs from admission/);db.exec("ROLLBACK");});
});
test("original proof survives caller mutation but detects journal identity changes",async()=>{
  await withDb(db=>{db.exec("BEGIN IMMEDIATE");const r=request();insert(db,r);const proof=recordNewAdmissionIn(db,r,null);r.targetThreadId="changed";(r.payload as {a:bigint}).a=8n;
    verifyRecordedAdmissionIn(db,proof);db.exec("UPDATE discord_ingress_journal SET target_thread_id='changed'");assert.throws(()=>verifyRecordedAdmissionIn(db,proof),/changed after ordinal/);db.exec("ROLLBACK");assert.deepEqual(counts(db),[0,0]);
  });
});
test("mutable lifecycle fields are excluded but raw payload bytes and timestamp bits are not",async()=>{
  await withDb(db=>{db.exec("BEGIN IMMEDIATE");insert(db,request());const proof=recordNewAdmissionIn(db,request(),null);
    db.exec("UPDATE discord_ingress_journal SET state='held',phase='later',hold_reason='hold',updated_at=12,confirmation_delivered=1");verifyRecordedAdmissionIn(db,proof);
    db.exec(`UPDATE discord_ingress_journal SET payload_json='{ "a": 1 }'`);assert.throws(()=>verifyRecordedAdmissionIn(db,proof),/changed after ordinal/);db.exec("ROLLBACK");
  });
  await withDb(db=>{db.exec("BEGIN IMMEDIATE");insert(db,request({now:0.5}));const proof=recordNewAdmissionIn(db,request({now:0.5}),null);db.exec("UPDATE discord_ingress_journal SET created_at=0.5000000000000001");assert.throws(()=>verifyRecordedAdmissionIn(db,proof),/changed after ordinal/);db.exec("ROLLBACK");});
});
test("capability format is rechecked on every record and proof verification",async()=>{
  await withDb(db=>{db.exec("BEGIN IMMEDIATE");insert(db,request());const proof=recordNewAdmissionIn(db,request(),null);db.exec("UPDATE cdr_runtime_capability_requirements SET format_version=2 WHERE component='recovery_admission_order'");
    assert.throws(()=>verifyRecordedAdmissionIn(db,proof),/unsupported current/);assert.throws(()=>recordNewAdmissionIn(db,request(),null),/unsupported current/);db.exec("ROLLBACK");assert.deepEqual(counts(db),[0,0]);
  });
});
test("ignored ordinal INSERT and post-insert identity or format tampering roll back original journal",async()=>{
  for(const trigger of ["BEFORE INSERT ON cdr_recovery_ingress_order BEGIN SELECT RAISE(IGNORE); END",
    "AFTER INSERT ON cdr_recovery_ingress_order BEGIN UPDATE discord_ingress_journal SET owner_user_id=9; END",
    "AFTER INSERT ON cdr_recovery_ingress_order BEGIN UPDATE cdr_runtime_capability_requirements SET format_version=2 WHERE component='recovery_admission_order'; END"]){
    await withDb(db=>{db.exec("CREATE TRIGGER test_tamper "+trigger);db.exec("BEGIN IMMEDIATE");insert(db,request());assert.throws(()=>recordNewAdmissionIn(db,request(),null));db.exec("ROLLBACK");assert.deepEqual(counts(db),[0,0]);});
  }
});
test("legacy ordinals remain old and max-i64 exhaustion refuses a new admission",async()=>{
  await withDb(db=>{db.exec("INSERT INTO cdr_recovery_ingress_order(ingress_id,kind,event_id,origin) VALUES (NULL,'message',8,'legacy')");db.exec("BEGIN IMMEDIATE");insert(db,request());recordNewAdmissionIn(db,request(),null);
    assert.deepEqual(db.prepare("SELECT sequence,origin,identity_sha256 FROM cdr_recovery_ingress_order ORDER BY sequence").all().map(r=>[r.sequence,r.origin,r.identity_sha256===null]),[[1,"legacy",true],[2,"admitted",false]]);db.exec("ROLLBACK");
  });
  await withDb(db=>{db.prepare("INSERT INTO cdr_recovery_ingress_order(sequence,kind,event_id,origin) VALUES (?,'action',NULL,'legacy')").run((1n<<63n)-1n);db.exec("BEGIN IMMEDIATE");insert(db,request());assert.throws(()=>recordNewAdmissionIn(db,request(),null),/sequence exhausted/);db.exec("ROLLBACK");});
});
test("duplicate recording cannot mint a fresh order and proof clones are not original custody",async()=>{
  await withDb(db=>{db.exec("BEGIN IMMEDIATE");insert(db,request());const proof=recordNewAdmissionIn(db,request(),null);
    assert.throws(()=>recordNewAdmissionIn(db,request(),null),/old ingress/);assert.throws(()=>verifyRecordedAdmissionIn(db,{...proof}),/proof is missing/);assert.throws(()=>verifyRecordedAdmissionIn(db,{} as RecordedAdmission),/proof is missing/);
    verifyRecordedAdmissionIn(db,proof);db.exec("ROLLBACK");
  });
});
test("action null-event identity and exact large i64 fields are retained losslessly",async()=>{
  await withDb(db=>{db.exec("BEGIN IMMEDIATE");const r=request({kind:"action",eventId:null,applicationId:(1n<<63n)-1n,sourceMessageId:-1n,channelId:9007199254740993n});insert(db,r,"resident");const proof=recordNewAdmissionIn(db,r,"resident");verifyRecordedAdmissionIn(db,proof);
    assert.equal(db.prepare("SELECT event_id FROM cdr_recovery_ingress_order").get()?.event_id,null);db.exec("ROLLBACK");
  });
});
