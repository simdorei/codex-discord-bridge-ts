import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {newThreadOriginIn} from "../../src/store/new-thread-origin.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {StoreIntegrityError} from "../../src/store/schema-assembly.ts";
async function withDb(run:(db:DatabaseSync)=>void):Promise<void>{await storeFixture(async path=>{const db=await openInitialized(path);try{run(db);}finally{db.close();}});}
function project(db:DatabaseSync,key:string,channel:bigint):void{db.prepare("INSERT INTO mirror_projects VALUES (?,?,?,?)").run(key,"title",channel,1);}
function thread(db:DatabaseSync,id:string,project:string,parent:bigint,room:bigint):void{db.prepare("INSERT INTO mirror_threads VALUES (?,?,?,?,?,?)").run(id,project,"title",parent,room,1);}
test("new thread origin preserves unmapped and exact mapped route fields",async()=>{
  await withDb(db=>{
    assert.deepEqual(newThreadOriginIn(db,1n),{version:1n,channel:1n,target:null,mapped_project:null,parent_channel:null,project:null,parent_project:null,chat_targets:[]});
    project(db,"parent",10n);project(db,"child",20n);thread(db,"target","mapped",10n,20n);
    assert.deepEqual(newThreadOriginIn(db,20n),{version:1n,channel:20n,target:"target",mapped_project:"mapped",parent_channel:10n,project:"child",parent_project:"parent",chat_targets:[]});
  });
});
test("new thread origin excludes mutable display metadata and preserves borrowed transaction",async()=>{
  await withDb(db=>{project(db,"parent",10n);thread(db,"target","parent",10n,20n);db.exec("BEGIN");const before=newThreadOriginIn(db,20n);
    db.exec("UPDATE mirror_threads SET thread_title='changed',updated_at=9; UPDATE mirror_projects SET project_name='changed',updated_at=9");
    assert.deepEqual(newThreadOriginIn(db,20n),before);assert.equal(db.isTransaction,true);db.exec("ROLLBACK");
  });
});
test("ambiguous chat parent records sorted candidates but ordinary project does not",async()=>{
  for(const key of ["codex:chats","projectless:example","ordinary"])await withDb(db=>{
    project(db,key,10n);thread(db,"z",key,10n,21n);thread(db,"a",key,10n,22n);
    const origin=newThreadOriginIn(db,10n);assert.equal(origin.target,null);assert.deepEqual(origin.chat_targets,key==="ordinary"?[]:["a","z"]);
  });
});
test("duplicate exact room and duplicate project mappings refuse new origin",async()=>{
  await withDb(db=>{thread(db,"a","p",10n,20n);thread(db,"b","p",10n,20n);assert.throws(()=>newThreadOriginIn(db,20n),StoreIntegrityError);});
  await withDb(db=>{project(db,"a",10n);project(db,"b",10n);assert.throws(()=>newThreadOriginIn(db,10n),/multiple project mappings/);});
});
test("new origin owned read matches borrowed snapshot and rejects invalid channel types",async()=>{
  await storeFixture(async path=>{const db=await openInitialized(path);let expected;try{thread(db,"a","p",10n,20n);expected=newThreadOriginIn(db,20n);
    for(const value of [1,1n<<63n,-(1n<<63n)-1n])assert.throws(()=>newThreadOriginIn(db,value as bigint),TypeError);
  }finally{db.close();}assert.deepEqual(await state.newThreadOrigin(path,20n),expected);});
});
