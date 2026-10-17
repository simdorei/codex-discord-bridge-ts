import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {CheckedRead,openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {initialCompletionCursor} from "../../src/store/completion-metadata.ts";
import {COMPLETION_SOURCES} from "../../src/store/completion-metadata-sql.ts";
import type {CompletionMetadataRound} from "../../src/store/completion-metadata-round.ts";
async function initialize(path:string,run?:(db:DatabaseSync)=>void){const db=await openInitialized(path);try{run?.(db);}finally{db.close();}}
const round=<T>(path:string,operation:(r:CompletionMetadataRound)=>T)=>state.readCompletionMetadataRound(path,"runtime",1n,operation);
test("no requested page means no file access and escaped reader expires",async()=>storeFixture(async path=>{
  let saved:CompletionMetadataRound|undefined;assert.equal(round(path,r=>{saved=r;return 42;}),42);assert.equal(existsSync(path),false);assert.throws(()=>saved!.page("Final",initialCompletionCursor()),/no valid read snapshot/);
}));
test("eight pages share one checked snapshot and finish before result publication",async()=>storeFixture(async path=>{
  await initialize(path);const originalOpen=CheckedRead.open,originalFinish=CheckedRead.prototype.finish;let opens=0,finishes=0;
  CheckedRead.open=function(p){opens++;return originalOpen.call(CheckedRead,p);};CheckedRead.prototype.finish=function(){finishes++;return originalFinish.call(this);};
  try{const results=round(path,r=>COMPLETION_SOURCES.map(source=>r.page(source,initialCompletionCursor())));assert.equal(results.length,8);assert.equal(opens,1);assert.equal(finishes,1);}finally{CheckedRead.open=originalOpen;CheckedRead.prototype.finish=originalFinish;}
}));
test("duplicate source is rejected while other source reads remain possible",async()=>storeFixture(async path=>{
  await initialize(path);assert.equal(round(path,r=>{r.page("Final",initialCompletionCursor());assert.throws(()=>r.page("Final",initialCompletionCursor()),/each of its eight sources once/);return r.page("Goal",initialCompletionCursor()).cursor.finished;}),true);
}));
test("open failure is sticky and original error wins even if callback catches page refusal",async()=>storeFixture(async path=>{
  let pageError:unknown,finishError:unknown;try{round(path,r=>{try{r.page("Final",initialCompletionCursor());}catch(e){pageError=e;}assert.throws(()=>r.page("Goal",initialCompletionCursor()),/no valid read snapshot/);return "not publishable";});}catch(e){finishError=e;}
  assert.ok(pageError);assert.ok(finishError);assert.notEqual(pageError,finishError);assert.equal(existsSync(path),false);
}));
test("post-page liveness failure invalidates whole round and does not advance input cursor",async()=>storeFixture(async path=>{
  await initialize(path);const original=CheckedRead.prototype.ensureActive;let calls=0;const sentinel=new Error("snapshot lost"),cursor=initialCompletionCursor();
  CheckedRead.prototype.ensureActive=function(){if(++calls===2)throw sentinel;return original.call(this);};
  try{assert.throws(()=>round(path,r=>{assert.throws(()=>r.page("Final",cursor),/no valid read snapshot/);return "discard";}),e=>e===sentinel);assert.equal(cursor.finished,false);}finally{CheckedRead.prototype.ensureActive=original;}
}));
test("finish failure prevents return of staged page results",async()=>storeFixture(async path=>{
  await initialize(path);const original=CheckedRead.prototype.finish,sentinel=new Error("commit failed");CheckedRead.prototype.finish=function(){throw sentinel;};
  try{assert.throws(()=>round(path,r=>r.page("Final",initialCompletionCursor())),e=>e===sentinel);}finally{CheckedRead.prototype.finish=original;}
}));
test("orphan sidecar requires one bounded orphan page and runs only once",async()=>storeFixture(async path=>{
  await initialize(path,db=>db.exec("INSERT INTO cdr_async_execution_obligations(question_id,thread_id,origin_job_id,turn_id,channel_id,format_version,revision,answer_state,execution_state,admission_state,policy,claim_json,original_error,created_at,updated_at) VALUES ('q','orphan','missing','turn',1,1,1,'waiting','unresolved','held','normal','{}','',1,1)"));
  const negative=round(path,r=>{
    assert.throws(()=>r.unprovableOrphans([]),/bounded current source page/);const page=r.page("AsyncOrphan",initialCompletionCursor());
    assert.throws(()=>r.unprovableOrphans(Array(33).fill(page.page.entries[0])),/bounded current source page/);
    const result=r.unprovableOrphans(page.page.entries);assert.throws(()=>r.unprovableOrphans(page.page.entries),/bounded current source page/);return result;
  });assert.deepEqual(negative,[0]);
}));
test("callback exception closes snapshot; async and generator callbacks never run",async()=>storeFixture(async path=>{
  await initialize(path);const sentinel={failure:true};let saved:CompletionMetadataRound|undefined;
  assert.throws(()=>round(path,r=>{saved=r;r.page("Final",initialCompletionCursor());throw sentinel;}),e=>e===sentinel);assert.throws(()=>saved!.page("Goal",initialCompletionCursor()),/no valid read snapshot/);
  let calls=0;assert.throws(()=>round(path,async()=>{calls++;return 1;}),/synchronous/);assert.throws(()=>round(path,function*(){calls++;yield 1;}),/synchronous/);assert.equal(calls,0);
}));
test("unsupported Promise return is rejected and its rejection is drained",async()=>storeFixture(async path=>{
  const failure=new Error("callback promise rejected");let saved:CompletionMetadataRound|undefined;
  assert.throws(()=>round(path,r=>{saved=r;return Promise.reject(failure);}),/must not return a Promise/);
  await new Promise<void>(resolve=>setImmediate(resolve));assert.throws(()=>saved!.page("Final",initialCompletionCursor()),/no valid read snapshot/);assert.equal(existsSync(path),false);
}));
