import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {migrateObservationGap} from "../../src/store/schema-extensions-a.ts";
import {activateObservationOn,discoverObservationOn,markUnknownObservationOn,nextObservationGapOn,observationScopeVerifiedOn,observationScopeVerifiedIn,type ObservationScope} from "../../src/store/observation-ledger.ts";
import {addVerifiedSequence,gapComplete,readGap,type ObservationGap} from "../../src/store/observation-gap-model.ts";
import {parseSerdeStructArray} from "../../src/core/serde-struct-json.ts";
import {withStoreTransaction,commitStore,rollbackStore} from "../../src/store/owned-scope.ts";
const scope:ObservationScope={ownerId:"owner😀",generation:9007199254740993n};
function fixture(encoding="UTF-8"){const db=new DatabaseSync(":memory:");db.exec(`PRAGMA encoding='${encoding}'`);migrateObservationGap(db);return db;}
function verified(db:DatabaseSync,first=1n,last=2n){db.prepare("UPDATE cdr_observation_gaps SET state='Verified',verified_json=? WHERE first_seq=? AND last_seq=?").run(`[{"first":${first},"last":${last}}]`,first,last);}
for(const encoding of ["UTF-8","UTF-16le","UTF-16be"]){
  test(`exact observation owner, generation and coverage in ${encoding}`,()=>{
    const db=fixture(encoding);try{activateObservationOn(db,scope);assert.equal(observationScopeVerifiedOn(db,scope,0n),true);discoverObservationOn(db,scope,2n);const gap=nextObservationGapOn(db,scope)!;assert.equal(gap.scope.ownerId,scope.ownerId);assert.equal(gap.scope.generation,scope.generation);assert.deepEqual([gap.first,gap.last,gap.cursor],[1n,2n,0n]);assert.equal(observationScopeVerifiedOn(db,scope,2n),false);verified(db);assert.equal(observationScopeVerifiedOn(db,scope,2n),true);assert.equal(db.isTransaction,false);}finally{db.close();}
  });
}
test("owner replacement preserves unsealed old tail even when its marker is later missing",()=>{
  const db=fixture();try{activateObservationOn(db,scope);discoverObservationOn(db,scope,2n);verified(db);const other={ownerId:"new",generation:scope.generation};activateObservationOn(db,other);assert.throws(()=>activateObservationOn(db,scope),/retired observation scope/);assert.equal(observationScopeVerifiedOn(db,other,0n),false);db.exec("DELETE FROM cdr_observation_gaps WHERE first_seq=0");assert.equal(observationScopeVerifiedOn(db,other,0n),false);assert.equal(observationScopeVerifiedOn(db,scope,2n),false);}finally{db.close();}
});
test("ignored old-tail insertion rolls activation back without retiring the current owner",()=>{
  const db=fixture();try{activateObservationOn(db,scope);db.exec("CREATE TRIGGER ignore_tail BEFORE INSERT ON cdr_observation_gaps WHEN NEW.first_seq=0 BEGIN SELECT RAISE(IGNORE); END");assert.throws(()=>activateObservationOn(db,{ownerId:"new",generation:1n}),/tail was not preserved/);assert.equal(db.prepare("SELECT active FROM cdr_observation_streams WHERE owner_id=?").get(scope.ownerId)!.active,1);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cdr_observation_streams").get()!.n,1);assert.equal(db.isTransaction,false);}finally{db.close();}
});
test("ignored unknown insert is refused while duplicate unknown retains the original evidence",()=>{
  const db=fixture();try{activateObservationOn(db,scope);db.exec("CREATE TRIGGER ignore_unknown BEFORE INSERT ON cdr_observation_gaps WHEN NEW.first_seq=0 BEGIN SELECT RAISE(IGNORE); END");assert.throws(()=>markUnknownObservationOn(db,scope,"first"),/not preserved/);db.exec("DROP TRIGGER ignore_unknown");markUnknownObservationOn(db,scope,"😀".repeat(513));const q=db.prepare("SELECT gap_id,revision,detail,state FROM cdr_observation_gaps"),original=q.get();assert.equal(Array.from(original!.detail as string).length,512);markUnknownObservationOn(db,scope,"overwrite");assert.deepEqual(q.get(),original);assert.equal(observationScopeVerifiedOn(db,scope,0n),false);}finally{db.close();}
});
for(const trigger of ["CREATE TRIGGER sabotage BEFORE INSERT ON cdr_observation_gaps WHEN NEW.first_seq>0 BEGIN SELECT RAISE(IGNORE); END","CREATE TRIGGER sabotage BEFORE UPDATE OF seen_seq ON cdr_observation_streams BEGIN SELECT RAISE(IGNORE); END","CREATE TRIGGER sabotage AFTER INSERT ON cdr_observation_gaps WHEN NEW.first_seq>0 BEGIN UPDATE cdr_observation_gaps SET last_seq=last_seq+1 WHERE gap_id=NEW.gap_id; END"]){
  test(`range/checkpoint sabotage rolls back both sides: ${trigger.split(" ").slice(0,7).join(" ")}`,()=>{
    const db=fixture();try{activateObservationOn(db,scope);db.exec(trigger);assert.throws(()=>discoverObservationOn(db,scope,2n));assert.equal(db.prepare("SELECT seen_seq FROM cdr_observation_streams").get()!.seen_seq,0);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cdr_observation_gaps").get()!.n,0);assert.equal(db.isTransaction,false);}finally{db.close();}
  });
}
test("older captured upper is a no-op and gap row IDs remain exact above 2^53",()=>{
  const db=fixture();try{activateObservationOn(db,scope);assert.equal(db.prepare("UPDATE sqlite_sequence SET seq=9007199254740992 WHERE name='cdr_observation_gaps'").run().changes,1);discoverObservationOn(db,scope,96n);const first=nextObservationGapOn(db,scope)!;assert.equal(first.id,9007199254740993n);discoverObservationOn(db,scope,32n);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cdr_observation_gaps").get()!.n,1);discoverObservationOn(db,scope,160n);const same=nextObservationGapOn(db,scope)!;assert.equal(same.id,first.id);assert.equal(same.last,96n);}finally{db.close();}
});
test("missing or incomplete verified range never becomes vacuous positive coverage",()=>{
  const db=fixture();try{activateObservationOn(db,scope);discoverObservationOn(db,scope,2n);verified(db);assert.equal(observationScopeVerifiedOn(db,scope,2n),true);db.exec("UPDATE cdr_observation_gaps SET verified_json='[{\"first\":1,\"last\":1}]'");assert.equal(observationScopeVerifiedOn(db,scope,2n),false);db.exec("DELETE FROM cdr_observation_gaps");assert.equal(observationScopeVerifiedOn(db,scope,2n),false);}finally{db.close();}
});
test("foreign unresolved gap blocks optional coverage without a target-local exception",()=>{
  const db=fixture();try{activateObservationOn(db,scope);markUnknownObservationOn(db,{ownerId:"foreign",generation:0n},"unknown");assert.equal(observationScopeVerifiedOn(db,scope,0n),false);}finally{db.close();}
});
test("typed span vector preserves derived-struct rules including duplicate refusal and sequence form",()=>{
  const shape={fields:[["first","i64"],["last","i64"]] as const};const spans=parseSerdeStructArray('[{"first":1,"last":2,"ignored":1e999},[3,4]]',shape);assert.deepEqual(spans.map(s=>[s.first,s.last]),[[1n,2n],[3n,4n]]);assert.deepEqual(parseSerdeStructArray("[]",shape),[]);
  for(const bad of ['[{"first":1,"first":1,"last":2}]','[{"first":1.0,"last":2}]','[{"first":1e0,"last":2}]','[{"first":9223372036854775808,"last":2}]','[null]','[{}]','{}','[[1,2,3]]'])assert.throws(()=>parseSerdeStructArray(bad,shape),SyntaxError,bad);
});
test("corrupt duplicate span JSON is a decode failure rather than coverage",()=>{
  const db=fixture();try{activateObservationOn(db,scope);discoverObservationOn(db,scope,2n);db.exec("UPDATE cdr_observation_gaps SET state='Verified',verified_json='[{\"first\":1,\"first\":1,\"last\":2}]'");assert.throws(()=>observationScopeVerifiedOn(db,scope,2n),/Duplicate/);assert.equal(db.isTransaction,false);db.exec("UPDATE cdr_observation_gaps SET verified_json=CAST(x'FF' AS TEXT)");assert.throws(()=>observationScopeVerifiedOn(db,scope,2n),/Invalid text encoding/);}finally{db.close();}
});
test("proof spans merge adjacency without overflow and enforce the 4096-span budget",()=>{
  const base:ObservationGap={id:1n,scope,first:1n,last:4n,cursor:0n,revision:0n,verified:[{first:1n,last:1n},{first:3n,last:4n}]};const merged=addVerifiedSequence(base,2n);assert.equal(gapComplete(merged),true);assert.deepEqual(merged.verified,[{first:1n,last:4n}]);assert.equal(base.verified.length,2);assert.throws(()=>addVerifiedSequence(base,5n),/outside range/);
  const budget={...base,last:20000n,verified:Array.from({length:4096},(_,i)=>({first:BigInt(i*2+1),last:BigInt(i*2+1)}))};assert.throws(()=>addVerifiedSequence(budget,19999n),/span budget/);
});
test("transaction scope preserves caller ownership and explicit rollback or failures undo writes",()=>{
  const db=fixture();try{db.exec("CREATE TABLE proof(v INTEGER)");withStoreTransaction(db,"IMMEDIATE",()=>{db.exec("INSERT INTO proof VALUES(1)");return rollbackStore(false);});assert.equal(db.prepare("SELECT COUNT(*) AS n FROM proof").get()!.n,0);const sentinel={};assert.throws(()=>withStoreTransaction(db,"IMMEDIATE",()=>{db.exec("INSERT INTO proof VALUES(2)");throw sentinel;}),e=>e===sentinel);assert.equal(db.prepare("SELECT COUNT(*) AS n FROM proof").get()!.n,0);assert.equal(db.isOpen,true);db.exec("BEGIN");assert.throws(()=>withStoreTransaction(db,"DEFERRED",()=>commitStore(true)));assert.equal(db.isTransaction,true);assert.equal(observationScopeVerifiedIn(db,scope,0n),false);db.exec("ROLLBACK");assert.throws(()=>observationScopeVerifiedIn(db,scope,0n),/active transaction/);}finally{db.close();}
});
test("sequence exhaustion, invalid scopes and hostile scope getters fail before mutation",()=>{
  const db=fixture();try{assert.throws(()=>activateObservationOn(db,{ownerId:"",generation:1n}),/invalid observation scope/);assert.throws(()=>activateObservationOn(db,{ownerId:"o",generation:-1n}),/invalid observation scope/);let calls=0;const hostile=Object.defineProperty({...scope},"ownerId",{get(){calls++;return "changed";}});assert.throws(()=>activateObservationOn(db,hostile));assert.equal(calls,0);activateObservationOn(db,scope);assert.throws(()=>discoverObservationOn(db,scope,(1n<<63n)-1n),/exhausted/);assert.equal(observationScopeVerifiedOn(db,scope,-1n),false);assert.equal(db.isTransaction,false);}finally{db.close();}
});

test("exhausted signed cursor revision fails closed without changing the stored snapshot",()=>{
  const db=fixture();try{activateObservationOn(db,scope);discoverObservationOn(db,scope,2n);const gap=nextObservationGapOn(db,scope)!;db.prepare("UPDATE cdr_observation_gaps SET scan_cursor=last_seq,revision=? WHERE gap_id=?").run((1n<<63n)-1n,gap.id);const before=readGap(db,gap.id);assert.throws(()=>nextObservationGapOn(db,scope),/overflow/);assert.deepEqual(readGap(db,gap.id),before);assert.equal(db.isTransaction,false);}finally{db.close();}
});
