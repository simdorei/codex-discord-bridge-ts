import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {validateStopRequestIn} from "../../src/store/stop-revision-read.ts";
const origin={target:"root",stopRevision:0n,archiveTargets:["root","child"]};
async function fixture(run:(db:DatabaseSync)=>void){await storeFixture(async path=>{const db=await openInitialized(path);try{run(db);}finally{db.close();}});}
function stop(db:DatabaseSync,target:string,revision:bigint){db.prepare("UPDATE cdr_stop_clock SET revision=?").run(revision);db.prepare("INSERT INTO cdr_stop_revision_receipts VALUES(?,?,?,'{}')").run("s"+revision,target,revision);db.prepare("INSERT OR REPLACE INTO cdr_stop_revisions VALUES(?,?,?)").run(target,revision,"s"+revision);}
test("archive derived scope requires one writer transaction and permits only member resumes or root archive",async()=>fixture(db=>{
  assert.throws(()=>validateStopRequestIn(db,"thread/archive","root",origin),/active transaction/);db.exec("BEGIN IMMEDIATE");
  validateStopRequestIn(db,"thread/resume","child",origin);validateStopRequestIn(db,"thread/resume","root",origin);validateStopRequestIn(db,"thread/archive","root",origin);
  for(const [method,target]of [["thread/archive","child"],["turn/start","child"],["thread/resume","foreign"]])assert.throws(()=>validateStopRequestIn(db,method!,target!,origin));
  assert.equal(db.isTransaction,true);db.exec("ROLLBACK");
}));
test("child stop revokes both child resume and final root archive, but unrelated stops do not",async()=>fixture(db=>{
  db.exec("BEGIN");stop(db,"unrelated",1n);validateStopRequestIn(db,"thread/archive","root",origin);stop(db,"child",2n);
  assert.throws(()=>validateStopRequestIn(db,"thread/archive","root",origin));assert.throws(()=>validateStopRequestIn(db,"thread/resume","root",origin));
  validateStopRequestIn(db,"thread/archive","root",{...origin,stopRevision:2n});db.exec("ROLLBACK");
}));
test("archive scope rejects duplicate, omitted root, malformed members and excess size without weakening ordinary target equality",async()=>fixture(db=>{
  db.exec("BEGIN");for(const value of [{...origin,extra:true},{...origin,archiveTargets:[]},{...origin,archiveTargets:["root","root"]},{...origin,archiveTargets:["child"]},{...origin,archiveTargets:["root"," child"]},{...origin,archiveTargets:["root",null]},{...origin,stopRevision:0},{...origin,archiveTargets:["root",...Array.from({length:101},(_,i)=>String(i))]},{...origin,archiveTargets:null}])assert.throws(()=>validateStopRequestIn(db,"thread/archive","root",value));
  validateStopRequestIn(db,"thread/archive","root",{...origin,archiveTargets:["root",...Array.from({length:100},(_,i)=>String(i))]});
  assert.throws(()=>validateStopRequestIn(db,"thread/resume","child",{target:"root",stopRevision:0n}));assert.throws(()=>validateStopRequestIn(db,"thread/resume","root",null));
  db.exec("ROLLBACK");
}));
test("archive member validation executes no accessors and uses original revision rather than recapturing it",async()=>fixture(db=>{
  db.exec("BEGIN");let calls=0;assert.throws(()=>validateStopRequestIn(db,"thread/archive","root",{...origin,get archiveTargets(){calls++;return ["root"];}}));assert.equal(calls,0);
  stop(db,"root",1n);assert.throws(()=>validateStopRequestIn(db,"thread/archive","root",origin));db.exec("ROLLBACK");
}));
