import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { test } from "node:test";
import { openInitialized } from "../../src/store/owned-driver.ts";
import { allJobs, selectJob } from "../../src/store/queue-read.ts";
import { complete,discardForGeneration,discardObserved,flush,retract } from "../../src/store/queue-remove.ts";
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>): Promise<void> {
  const root=resolve(realpathSync(tmpdir()));
  const dir=mkdtempSync(join(root,"cdr-ts-queue-remove-"));
  const path=join(dir,"store.sqlite");
  const db=await openInitialized(path);
  try {await run(path,db);}
  finally {
    try {db.close();} catch {}
    const actual=resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(),resolve(dir).toLowerCase());
    assert.equal(dirname(actual).toLowerCase(),root.toLowerCase());
    rmSync(actual,{recursive:true,force:true});
  }
}
function insert(db:DatabaseSync,id:string,target:string,generation:bigint,state="pending",time=1,owner:bigint|null=7n):void {
  db.prepare("INSERT INTO codex_turn_queue (job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES (?,?,5,?,?,'prompt',1,0,?,0,'[]',?,?)")
    .run(id,target,owner,generation,state,time,time);
}
test("complete refuses a dead-generation-held target but deletes an unheld job once",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"held","t",1n);insert(db,"free","u",1n);
    db.prepare("INSERT INTO codex_dead_generation_holds VALUES ('t','runtime',1,0)").run();
    assert.equal(await complete(path,"held"),false);
    assert.equal(await complete(path,"free"),true);
    assert.equal(await complete(path,"free"),false);
    assert.equal(selectJob(db,"held").jobId,"held");
  });
});
test("generation discard preserves only matching generation and returns ordered original rows",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"b","t",2n);insert(db,"a","t",1n);insert(db,"c","u",3n,"running",2);
    const removed=await discardForGeneration(path,2n);
    assert.deepEqual(removed.map(j=>j.jobId),["a","c"]);
    assert.deepEqual(allJobs(db).map(j=>j.jobId),["b"]);
  });
});
test("null generation discards all rows using the source's unguarded delete contract",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"a","t",1n);
    db.prepare("INSERT INTO codex_dead_generation_holds VALUES ('t','runtime',1,0)").run();
    assert.equal((await discardForGeneration(path,null)).length,1);
    assert.equal(allJobs(db).length,0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM codex_dead_generation_holds").get()!.n,1);
  });
});
test("observed discard matches only ID and generation and returns current row contents",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"a","t",1n);insert(db,"b","t",2n);
    const observed=[selectJob(db,"a"),selectJob(db,"b")];
    db.exec("UPDATE codex_turn_queue SET prompt='current',state='running' WHERE job_id='a'; UPDATE codex_turn_queue SET app_server_generation=3 WHERE job_id='b'");
    const removed=await discardObserved(path,observed);
    assert.equal(removed.length,1);assert.equal(removed[0]!.prompt,"current");
    assert.equal(removed[0]!.state,"Running");
    assert.deepEqual(allJobs(db).map(j=>j.jobId),["b"]);
  });
});
test("observed identities are snapshotted before await",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"a","t",1n);
    const observed=[selectJob(db,"a")];
    const pending=discardObserved(path,observed);
    observed[0]!.jobId="different";observed.length=0;
    assert.equal((await pending)[0]!.jobId,"a");
  });
});
test("flush selects exact target and generation",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"a","t",1n);insert(db,"b","t",2n);insert(db,"c","u",1n);
    assert.deepEqual((await flush(path,"t",1n)).map(j=>j.jobId),["a"]);
    assert.deepEqual(allJobs(db).map(j=>j.jobId),["b","c"]);
  });
});
test("retract chooses the last pending match in created_at/job_id ordering",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"a","t",1n);insert(db,"z","t",1n);insert(db,"running","t",1n,"running",2);
    assert.equal((await retract(path,"t",5n,7n))!.jobId,"z");
    assert.deepEqual(allJobs(db).map(j=>j.jobId),["a","running"]);
    assert.equal(await retract(path,"t",99n,7n),null);
    assert.equal(await retract(path,"t",5n,99n),null);
  });
});
test("null owner filter permits ownerless pending jobs",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"a","t",1n,"pending",1,null);
    assert.equal(await retract(path,"t",null,7n),null);
    assert.equal((await retract(path,"t",null,null))!.jobId,"a");
  });
});
test("all rows decode before discard filtering, so corruption prevents partial deletion",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"a","t",1n);insert(db,"b","t",2n);
    db.exec("UPDATE codex_turn_queue SET baseline_turn_ids='{' WHERE job_id='b'");
    await assert.rejects(()=>discardForGeneration(path,2n));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM codex_turn_queue").get()!.n,2);
  });
});
test("a later delete error rolls back an earlier delete in the same transaction",async()=>{
  await fixture(async(path,db)=>{
    insert(db,"a","t",1n);insert(db,"b","t",1n);
    db.exec("CREATE TRIGGER fail_second BEFORE DELETE ON codex_turn_queue WHEN OLD.job_id='b' BEGIN SELECT RAISE(ABORT,'blocked'); END;");
    await assert.rejects(()=>flush(path,"t",1n),/blocked/);
    assert.deepEqual(allJobs(db).map(j=>j.jobId),["a","b"]);
  });
});
