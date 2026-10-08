import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {activateObservationOn,discoverObservationOn,nextObservationGapOn,observationScopeVerifiedOn} from "../../src/store/observation-ledger.ts";
import {certifyObservationOn,finishObservationPageOn,type ObservationEffect} from "../../src/store/observation-proof.ts";
import {readGap,gapContains,type ObservationScope} from "../../src/store/observation-gap-model.ts";
const scope:ObservationScope={ownerId:"resident",generation:7n};
const noStore:ObservationEffect={kind:"NoRequiredStore"};
async function fixture(run:(db:DatabaseSync,path:string)=>void|Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{activateObservationOn(db,scope);await run(db,path);}finally{if(db.isOpen)db.close();}});}
function running(db:DatabaseSync,id="job",owner=2n){db.prepare(`INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at,app_server_generation)
 VALUES(?,'T',1,?,'prompt',1,1,'running',3,'V','[]',0,0,7)`).run(id,owner);}
function question(db:DatabaseSync,id="question",turn="V",confirmed=1){db.prepare(`INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,owner_confirmed,created_at,updated_at)
 VALUES(?,'resident',7,'T',?,'item','job',1,2,'body','observed',?,0,0)`).run(id,turn,confirmed);}
test("nonempty typed effects are all required, even when a sequence was previously certified",async()=>fixture(db=>{
  discoverObservationOn(db,scope,2n);assert.equal(certifyObservationOn(db,scope,1n,[]),false);assert.equal(certifyObservationOn(db,scope,1n,[noStore,{kind:"Unconfirmed"}]),false);assert.equal(certifyObservationOn(db,scope,1n,[noStore]),true);assert.equal(certifyObservationOn(db,scope,1n,[{kind:"Terminal",thread:"T",turn:"V",payload:"missing"}]),false);assert.equal(certifyObservationOn(db,scope,0n,[noStore]),false);assert.equal(certifyObservationOn(db,{ownerId:"other",generation:7n},1n,[noStore]),false);
}));
test("terminal evidence requires exact resident, generation, identities and raw payload",async()=>fixture(db=>{
  discoverObservationOn(db,scope,2n);const e:ObservationEffect={kind:"Terminal",thread:"T",turn:"V",payload:"one"};assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES('T','V',7,'one','wrong')");assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("UPDATE codex_observed_completions SET resident_owner='resident'");assert.equal(certifyObservationOn(db,scope,1n,[e]),true);assert.equal(certifyObservationOn(db,scope,2n,[{...e,payload:"different"}]),false);assert.equal(observationScopeVerifiedOn(db,scope,2n),false);
}));
test("final evidence uses exact stored generation and content",async()=>fixture(db=>{
  discoverObservationOn(db,scope,1n);const e:ObservationEffect={kind:"Final",thread:"T",turn:"V",content:"answer"};assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("INSERT INTO codex_observed_final_answers(thread_id,turn_id,generation,content) VALUES('T','V',6,'answer')");assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("UPDATE codex_observed_final_answers SET generation=7");assert.equal(certifyObservationOn(db,scope,1n,[e]),true);assert.equal(certifyObservationOn(db,scope,1n,[{...e,content:"different"}]),false);
}));
test("started effect requires one exact running owner and no competing active question",async()=>fixture(db=>{
  discoverObservationOn(db,scope,1n);const e:ObservationEffect={kind:"Started",thread:"T",turn:"V"};assert.equal(certifyObservationOn(db,scope,1n,[e]),false);running(db);assert.equal(certifyObservationOn(db,scope,1n,[e]),true);running(db,"duplicate");assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("DELETE FROM codex_turn_queue WHERE job_id='duplicate'");question(db,"other","other-turn");assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("UPDATE cdr_async_questions SET state='expired'");assert.equal(certifyObservationOn(db,scope,1n,[e]),true);
}));
test("completed-origin proof preserves its exact owner, generation, turn and nonempty job requirement",async()=>fixture(db=>{
  discoverObservationOn(db,scope,1n);const e:ObservationEffect={kind:"Started",thread:"T",turn:"V"};db.exec("INSERT INTO cdr_idle_release(intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state) VALUES('i','resident',7,'T','V','job',1,'Candidate')");assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("INSERT INTO codex_session_mirror_events(event_digest,codex_thread_id,created_at) VALUES('discord-origin:v1:T:V','T',0)");assert.equal(certifyObservationOn(db,scope,1n,[e]),true);db.exec("UPDATE cdr_idle_release SET job_id=''");assert.equal(certifyObservationOn(db,scope,1n,[e]),false);
}));
test("question proof requires owner confirmation and exact body/item identity",async()=>fixture(db=>{
  discoverObservationOn(db,scope,1n);question(db,"question","V",0);const e:ObservationEffect={kind:"Question",id:"question",thread:"T",turn:"V",item:"item",body:"body"};assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("UPDATE cdr_async_questions SET owner_confirmed=1");assert.equal(certifyObservationOn(db,scope,1n,[e]),true);assert.equal(certifyObservationOn(db,scope,1n,[{...e,item:"other"}]),false);assert.equal(certifyObservationOn(db,scope,1n,[{...e,body:"different"}]),false);
}));
test("proof write failure and ignored CAS never produce certified progress",async()=>fixture(db=>{
  discoverObservationOn(db,scope,1n);const before=nextObservationGapOn(db,scope)!;db.exec("CREATE TRIGGER fail_proof BEFORE UPDATE ON cdr_observation_gaps BEGIN SELECT RAISE(ABORT,'proof write failure'); END");assert.throws(()=>certifyObservationOn(db,scope,1n,[noStore]),/proof write failure/);assert.deepEqual(readGap(db,before.id),before);db.exec("DROP TRIGGER fail_proof; CREATE TRIGGER ignore_proof BEFORE UPDATE ON cdr_observation_gaps BEGIN SELECT RAISE(IGNORE); END");assert.throws(()=>certifyObservationOn(db,scope,1n,[noStore]),/proof CAS lost/);assert.equal(finishObservationPageOn(db,before,1n),false);assert.deepEqual(readGap(db,before.id),before);assert.equal(db.isTransaction,false);
}));
test("fixed G1 scan revisits its middle hole even as newer G2/G3 ranges grow",async()=>fixture(db=>{
  const prove=(first:number,last:number)=>{for(let i=first;i<=last;i++)assert.equal(certifyObservationOn(db,scope,BigInt(i),[noStore]),true);};discoverObservationOn(db,scope,96n);const g1=nextObservationGapOn(db,scope)!;prove(1,32);assert.equal(finishObservationPageOn(db,g1,32n),false);assert.equal(finishObservationPageOn(db,nextObservationGapOn(db,scope)!,32n),true);discoverObservationOn(db,scope,160n);assert.equal(nextObservationGapOn(db,scope)!.id,g1.id);prove(41,64);assert.equal(finishObservationPageOn(db,nextObservationGapOn(db,scope)!,64n),true);discoverObservationOn(db,scope,224n);prove(65,96);const current=nextObservationGapOn(db,scope)!;assert.deepEqual(current.verified,[{first:1n,last:32n},{first:41n,last:96n}]);assert.equal(finishObservationPageOn(db,current,96n),true);assert.equal(observationScopeVerifiedOn(db,scope,96n),false);
  for(const through of [32n,64n,96n]){const gap=nextObservationGapOn(db,scope)!;assert.equal(gap.id,g1.id);assert.equal(finishObservationPageOn(db,gap,through),true);}const g2=nextObservationGapOn(db,scope)!;assert.notEqual(g2.id,g1.id);assert.deepEqual([g2.first,g2.last],[97n,160n]);const saved=readGap(db,g1.id)!;assert.equal(saved.cursor,96n);assert.equal(gapContains(saved,33n),false);assert.equal(gapContains(saved,96n),true);
}));
test("scan-page claim compares exact proof spans as well as identity, revision and cursor",async()=>fixture(db=>{
  discoverObservationOn(db,scope,2n);const gap=nextObservationGapOn(db,scope)!;for(const changed of [{...gap,revision:gap.revision+1n},{...gap,scope:{...gap.scope,ownerId:"other"}},{...gap,verified:[{first:1n,last:1n}]}])assert.equal(finishObservationPageOn(db,changed,1n),false);assert.throws(()=>finishObservationPageOn(db,gap,0n),/invalid observation scan/);assert.equal(finishObservationPageOn(db,gap,1n),true);assert.equal(observationScopeVerifiedOn(db,scope,0n),false);
}));
test("owned facade proof snapshots inputs before async opening and persists only matching effects",async()=>fixture(async(db,path)=>{
  discoverObservationOn(db,scope,1n);db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES('T','V',7,'one','resident')");const e={kind:"Terminal" as const,thread:"T",turn:"V",payload:"one"};const promise=state.certifyObservation(path,scope,1n,[e]);e.payload="mutated";assert.equal(await promise,true);assert.equal(await state.observationScopeVerified(path,scope,1n),true);const current=readGap(db,1n)!;assert.equal(await state.finishObservationPage(path,current,1n),true);
}));
test("waiting inbox proof compares every original queue identity including nullable execution generation",async()=>fixture(db=>{
  discoverObservationOn(db,scope,1n);running(db);db.exec(`INSERT INTO cdr_async_question_inbox(id,runtime_id,generation,thread_id,turn_id,item_id,candidate_job_id,candidate_channel_id,candidate_owner_id,body,state,created_at,candidate_generation,candidate_execution_generation,candidate_attempt_count)
    VALUES('inbox','resident',7,'T','V','item','job',1,2,'body','waiting',0,7,NULL,3)`);
  const e:ObservationEffect={kind:"Question",id:"inbox",thread:"T",turn:"V",item:"item",body:"body"};assert.equal(certifyObservationOn(db,scope,1n,[e]),true);
  for(const [column,bad,good] of [["candidate_channel_id",2,1],["candidate_owner_id",3,2],["candidate_generation",6,7],["candidate_attempt_count",4,3]] as const){db.exec(`UPDATE cdr_async_question_inbox SET ${column}=${bad}`);assert.equal(certifyObservationOn(db,scope,1n,[e]),false,column);db.exec(`UPDATE cdr_async_question_inbox SET ${column}=${good}`);}
  db.exec("UPDATE cdr_async_question_inbox SET candidate_execution_generation=0");assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("UPDATE cdr_async_question_inbox SET candidate_execution_generation=NULL,state='expired'");assert.equal(certifyObservationOn(db,scope,1n,[e]),false);db.exec("UPDATE cdr_async_question_inbox SET state='waiting'; UPDATE codex_turn_queue SET owner_user_id=NULL");assert.equal(certifyObservationOn(db,scope,1n,[e]),false);
}));
test("invalid effect discriminators and hostile expected claims are refused before proof mutation",async()=>fixture(db=>{
  discoverObservationOn(db,scope,1n);const gap=nextObservationGapOn(db,scope)!;assert.throws(()=>certifyObservationOn(db,scope,1n,[{kind:"Unknown"} as unknown as ObservationEffect]),/Unknown observation/);let calls=0;const bad=Object.defineProperty({...gap},"revision",{get(){calls++;return gap.revision;}});assert.throws(()=>finishObservationPageOn(db,bad,1n));assert.equal(calls,0);assert.deepEqual(readGap(db,gap.id),gap);assert.equal(db.isTransaction,false);
}));
