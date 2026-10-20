import assert from "node:assert/strict";
import {test} from "node:test";
import {DatabaseSync} from "node:sqlite";
import {existsSync} from "node:fs";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {parseStopControlJson,serializeStopControl,type StopControl} from "../../src/store/stop-control-dispatch.ts";
import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import {StoreIntegrityError} from "../../src/store/schema-assembly.ts";
const control=(op="op"):StopControl=>({operation_id:op,target:"T",channel:42n,owner:3n,resident:"R",generation:1n,turn:"V",binding:{target:"T",route:"Explicit",command:{Stop:{reference:"T"}}},jobs:['{"timestamp":1.0}'],can_settle:true});
function insert(db:DatabaseSync,op:string,raw=serializeStopControl(control(op)),phase="accepted"){db.prepare("INSERT INTO cdr_stop_controls(operation_id,target_thread_id,resident_owner,generation,turn_id,record_json,phase) VALUES(?,'T','R',1,'V',?,?)").run(op,raw,phase);}
async function fixture(run:(path:string,db:DatabaseSync)=>void){await storeFixture(async path=>{const db=await openInitialized(path);try{run(path,db);}finally{db.close();}});}
test("pending stop keysets are at most sixteen, sequence ordered and phase filtered",async()=>fixture((path,db)=>{
  for(let i=0;i<20;i++)insert(db,`op${i}`);db.exec("UPDATE cdr_stop_controls SET phase='acknowledged' WHERE sequence=2");const first=state.pendingStopControlsAfter(path,0n);assert.equal(first.length,16);assert.equal(first[0]![0],1n);assert.equal(first.at(-1)![0],17n);const second=state.pendingStopControlsAfter(path,17n);assert.deepEqual(second.map(r=>r[0]),[18n,19n,20n]);assert.deepEqual(state.pendingStopControlsAfter(path,20n),[]);assert.equal(state.stopControlPhase(path,"op1"),"acknowledged");assert.equal(state.stopControlPhase(path,"missing"),null);assert.equal(db.prepare("SELECT count(*) AS n FROM cdr_stop_controls WHERE claim_token IS NOT NULL").get()!.n,0);
}));
test("typed stop struct preserves opaque jobs, supports source sequences and ignored fields",()=>{
  const c=control(),raw=serializeStopControl(c);assert.equal(serializeStopControl(parseStopControlJson(raw)),raw);assert.equal(parseStopControlJson(serializeSerdeValue(Object.values(c))).jobs[0],c.jobs[0]);
  const extra=raw.slice(0,-1)+',"ignored":1e400,"ignored":"\\ud800"}';assert.equal(serializeStopControl(parseStopControlJson(extra)),raw);
});
for(const [label,edit] of [
  ["duplicate recognized",(s:string)=>s.replace('"target":"T"','"target":"T","target":"U"')],
  ["missing required",(s:string)=>s.replace('"resident":"R",',"")],
  ["float integer",(s:string)=>s.replace('"generation":1,','"generation":1.0,')],
  ["integer overflow",(s:string)=>s.replace('"generation":1,','"generation":9223372036854775808,')],
  ["wrong bool",(s:string)=>s.replace('"can_settle":true','"can_settle":1')],
  ["wrong job",(s:string)=>s.replace('"jobs":["{\\"timestamp\\":1.0}"]','"jobs":[null]')],
] as const)test(`pending raw schema rejects ${label}`,async()=>fixture((path,db)=>{const raw=serializeStopControl(control()),changed=edit(raw);assert.notEqual(changed,raw);insert(db,"op",changed);assert.throws(()=>state.pendingStopControlsAfter(path,0n));assert.equal(state.stopControlPhase(path,"op"),"accepted");}));
test("all SQLite row type/UTF-8 errors precede raw JSON parsing",async()=>fixture((path,db)=>{
  insert(db,"first","not json");insert(db,"second");db.exec("UPDATE cdr_stop_controls SET record_json=CAST(x'ff' AS TEXT) WHERE operation_id='second'");assert.throws(()=>state.pendingStopControlsAfter(path,0n),StoreIntegrityError);
}));
test("existing-only reads never initialize missing or partial schema and validate cursors first",async()=>storeFixture(async path=>{
  assert.throws(()=>state.pendingStopControlsAfter(path,0n));assert.throws(()=>state.stopControlPhase(path,"op"));assert.equal(existsSync(path),false);assert.throws(()=>state.pendingStopControlsAfter(path,1n<<63n));
  const db=new DatabaseSync(path);try{db.exec("CREATE TABLE sentinel(x)");assert.throws(()=>state.pendingStopControlsAfter(path,0n));assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name),["sentinel"]);}finally{db.close();}
}));
test("production phase CHECK rejects invalid text without weakening the schema",async()=>fixture((path,db)=>{insert(db,"op");assert.throws(()=>db.exec("UPDATE cdr_stop_controls SET phase=CAST(x'ff' AS TEXT)"),/CHECK constraint failed/);assert.equal(state.stopControlPhase(path,"op"),"accepted");}));

test("diagnostic legacy table with corrupt phase is rejected by text decoding",async()=>storeFixture(async path=>{
  const db=new DatabaseSync(path);try{db.exec("CREATE TABLE cdr_stop_controls(operation_id TEXT,phase TEXT);INSERT INTO cdr_stop_controls VALUES('op',CAST(x'ff' AS TEXT))");assert.throws(()=>state.stopControlPhase(path,"op"),StoreIntegrityError);}finally{db.close();}
}));
