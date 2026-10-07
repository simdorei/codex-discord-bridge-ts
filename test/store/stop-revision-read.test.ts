import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {captureStopOriginIn,currentStopRevisionIn,targetStopRevisionIn,latestStopScopeIn,validateStopRevisionIn,stopOriginForIngress} from "../../src/store/stop-revision-read.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import type {StoredIngress} from "../../src/store/ingress-read.ts";
import {StoreIntegrityError} from "../../src/store/schema-assembly.ts";
async function withDb(run:(db:DatabaseSync)=>void):Promise<void>{await storeFixture(async path=>{const db=await openInitialized(path);try{run(db);}finally{db.close();}});}
function stop(db:DatabaseSync,target:string,revision:bigint):void{
  const op=`stop-${revision}`;db.prepare("UPDATE cdr_stop_clock SET revision=?").run(revision);
  db.prepare("INSERT INTO cdr_stop_revision_receipts VALUES (?,?,?,?)").run(op,target,revision,"{}");
  db.prepare("INSERT OR REPLACE INTO cdr_stop_revisions VALUES (?,?,?)").run(target,revision,op);
}
test("stop capture requires existing transaction and reads current immutable scope",async()=>{
  await withDb(db=>{assert.throws(()=>captureStopOriginIn(db,"a"),/active transaction/);db.exec("BEGIN");
    assert.deepEqual(captureStopOriginIn(db,"a"),{target:"a",stopRevision:0n});assert.equal(latestStopScopeIn(db,"a"),null);
    stop(db,"a",1n);assert.deepEqual(captureStopOriginIn(db,"a"),{target:"a",stopRevision:1n});assert.deepEqual(latestStopScopeIn(db,"a"),["stop-1","{}"]);
    assert.equal(db.isTransaction,true);db.exec("ROLLBACK");assert.equal(currentStopRevisionIn(db),0n);
  });
});
test("legacy requests cannot borrow current stop revision and unrelated stops do not revoke target",async()=>{
  await withDb(db=>{stop(db,"a",1n);stop(db,"b",2n);
    assert.throws(()=>validateStopRevisionIn(db,"a"),/predates stop/);
    validateStopRevisionIn(db,"c");validateStopRevisionIn(db,"a",{target:"a",stopRevision:1n});
    assert.throws(()=>validateStopRevisionIn(db,"b",{target:"b",stopRevision:1n}),StoreIntegrityError);
    validateStopRevisionIn(db,null,{target:null,stopRevision:1n});
  });
});
test("ordinary stop origin requires exact own data fields without executing accessors or proxies",async()=>{
  await withDb(db=>{
    let calls=0;const getter={target:"a",get stopRevision(){calls++;return 0n;}};
    const proxy=new Proxy({target:"a",stopRevision:0n},{ownKeys(){calls++;return ["target","stopRevision"];}});
    for(const value of [null,{},[],{target:"b",stopRevision:0n},{target:"a",stopRevision:0},{target:"a",stopRevision:-1n},{target:"a",stopRevision:1n},
      {target:"a",stopRevision:0n,archiveTargets:[]},{target:"a",stopRevision:0n,[Symbol()]:true},getter,proxy])assert.throws(()=>validateStopRevisionIn(db,"a",value),StoreIntegrityError);
    assert.equal(calls,0);validateStopRevisionIn(db,"",{target:"",stopRevision:0n});validateStopRevisionIn(db,"😀",{target:"😀",stopRevision:0n});
    assert.throws(()=>validateStopRevisionIn(db,"\ud800"),TypeError);
  });
});
test("inconsistent global clock and per-target history are refused",async()=>{
  for(const mutation of ["DELETE FROM cdr_stop_clock","UPDATE cdr_stop_clock SET revision=2","UPDATE cdr_stop_revisions SET operation_id='other'","DELETE FROM cdr_stop_revisions",
    "UPDATE cdr_stop_revisions SET operation_id=CAST(x'80' AS TEXT)"])await withDb(db=>{stop(db,"a",1n);db.exec(mutation);assert.throws(()=>validateStopRevisionIn(db,"a",{target:"a",stopRevision:1n}));});
});
test("original ingress stop origin preserves absence, rejects null and returns isolated data",()=>{
  const record=(payload:unknown)=>({payload,targetThreadId:"a"}) as StoredIngress;
  assert.equal(stopOriginForIngress(record({})),undefined);assert.throws(()=>stopOriginForIngress(record({stop_origin:null})),StoreIntegrityError);
  const origin={target:"a",stopRevision:0n};const read=stopOriginForIngress(record({stop_origin:origin}));assert.deepEqual(read,origin);assert.notEqual(read,origin);
  for(const value of [{target:"b",stopRevision:0n},{target:"a",stopRevision:-1n},{target:"a",stopRevision:0n,extra:1}])assert.throws(()=>stopOriginForIngress(record({stop_origin:value})),StoreIntegrityError);
});
test("owned stop capture is read-only and does not create or migrate absent schema",async()=>{
  await storeFixture(async path=>{assert.throws(()=>state.captureStopOrigin(path,"a"));assert.equal(existsSync(path),false);
    const db=new DatabaseSync(path);db.exec("CREATE TABLE sentinel (value TEXT)");db.close();assert.throws(()=>state.captureStopOrigin(path,"a"));
    const inspect=new DatabaseSync(path);try{assert.deepEqual(inspect.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name),["sentinel"]);}finally{inspect.close();}
  });
  await storeFixture(async path=>{const db=await openInitialized(path);stop(db,"a",1n);db.close();assert.deepEqual(state.captureStopOrigin(path,"a"),{target:"a",stopRevision:1n});});
});
