import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { test } from "node:test";
import { initialize, openInitialized } from "../../src/store/owned-driver.ts";
import { selectJob } from "../../src/store/queue-read.ts";
import {
  enqueue,enqueueIfMirrorMatches,enqueueInTransaction,ensureMirrorMatches,MirrorMappingChangedError,
} from "../../src/store/queue-enqueue.ts";
import type { NewQueueJob } from "../../src/store/queue-enqueue.ts";

function job(overrides: Partial<NewQueueJob>={}): NewQueueJob {
  return {jobId:"j",targetThreadId:"target",channelId:9007199254740993n,
    ownerUserId:7n,discordMessageId:9n,appServerGeneration:11n,
    prompt:"한글😀",queued:true,ackSent:false,createdAt:1000,...overrides};
}
async function memory(): Promise<DatabaseSync> {
  const db=new DatabaseSync(":memory:");await initialize(db,":memory:");return db;
}
async function fileTest(run:(path:string)=>Promise<void>): Promise<void> {
  const root=resolve(realpathSync(tmpdir()));
  const dir=mkdtempSync(join(root,"cdr-ts-enqueue-"));
  try { await run(join(dir,"store.sqlite")); }
  finally {
    const actual=resolve(realpathSync(dir));
    assert.equal(actual.toLowerCase(),resolve(dir).toLowerCase());
    assert.equal(dirname(actual).toLowerCase(),root.toLowerCase());
    rmSync(actual,{recursive:true,force:true});
  }
}
test("borrowed enqueue preserves fields and transaction ownership",async()=>{
  const db=await memory();
  try {
    db.exec("BEGIN IMMEDIATE");
    const result=enqueueInTransaction(db,job());
    assert.equal(result.created,true);
    assert.equal(result.job.channelId,9007199254740993n);
    assert.equal(result.job.prompt,"한글😀");
    assert.equal(result.job.state,"Pending");
    assert.equal(result.job.attemptCount,0n);
    assert.deepEqual(result.job.baselineTurnIds,[]);
    assert.equal(result.job.createdAt,1000);
    assert.equal(result.job.updatedAt,1000);
    assert.equal(db.isTransaction,true);
    db.exec("ROLLBACK");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM codex_turn_queue").get()!.n,0);
  } finally {db.close();}
});
test("duplicate Discord message returns original job without overwriting it",async()=>{
  const db=await memory();
  try {
    const first=enqueueInTransaction(db,job());
    const again=enqueueInTransaction(db,job({jobId:"different",prompt:"new"}));
    assert.equal(again.created,false);
    assert.deepEqual(again.job,first.job);
  } finally {db.close();}
});
test("duplicate ID with null message returns existing ID",async()=>{
  const db=await memory();
  try {
    const first=enqueueInTransaction(db,job({discordMessageId:null}));
    assert.deepEqual(enqueueInTransaction(db,job({discordMessageId:null,prompt:"ignored"})),
      {job:first.job,created:false});
  } finally {db.close();}
});
test("duplicate ID with a different non-null message is not silently adopted",async()=>{
  const db=await memory();
  try {
    enqueueInTransaction(db,job());
    assert.throws(()=>enqueueInTransaction(db,job({discordMessageId:10n})),/durable queue job not found: 10/);
    assert.equal(selectJob(db,"j").discordMessageId,9n);
  } finally {db.close();}
});
test("exact mirror duplicates refuse without project fallback",async()=>{
  const db=await memory();
  try {
    const insert=db.prepare("INSERT INTO mirror_threads VALUES (?, 'p', 'title', ?, ?, 0)");
    insert.run("target",1n,9007199254740993n);
    ensureMirrorMatches(db,job(),{discordChannelId:9007199254740993n,targetThreadId:"target"});
    insert.run("other",2n,9007199254740993n);
    assert.throws(()=>ensureMirrorMatches(db,job(),{discordChannelId:9007199254740993n,targetThreadId:"target"}),MirrorMappingChangedError);
  } finally {db.close();}
});
test("project fallback is allowed only for one candidate",async()=>{
  const db=await memory();
  try {
    const insert=db.prepare("INSERT INTO mirror_threads VALUES (?, 'p', 'title', ?, ?, ?)");
    insert.run("target",9007199254740993n,21n,0);
    ensureMirrorMatches(db,job(),{discordChannelId:9007199254740993n,targetThreadId:"target"});
    insert.run("other",9007199254740993n,22n,100);
    assert.throws(()=>ensureMirrorMatches(db,job(),{discordChannelId:9007199254740993n,targetThreadId:"target"}),MirrorMappingChangedError);
  } finally {db.close();}
});
test("owned enqueue snapshots input before its first await and commits",async()=>{
  await fileTest(async path=>{
    const input=job();
    const pending=enqueue(path,input);
    input.prompt="mutated";input.jobId="changed";input.discordMessageId=10n;
    const result=await pending;
    assert.equal(result.job.jobId,"j");assert.equal(result.job.prompt,"한글😀");
    const db=await openInitialized(path);
    try { assert.equal(selectJob(db,"j").discordMessageId,9n); }
    finally {db.close();}
  });
});
test("owned failure rolls back idle cancellation and preserves stop hold",async()=>{
  await fileTest(async path=>{
    const db=await openInitialized(path);
    db.prepare("INSERT INTO cdr_idle_release VALUES ('intent','owner',1,'target','turn','job',7,'Candidate','old')").run();
    db.prepare("INSERT INTO discord_ingress_journal (ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,outcome_json,created_at,updated_at) VALUES ('message:9','message',9,1,7,'{}','held','staged','{\"stop_hold\":null}',0,0)").run();
    db.close();
    await assert.rejects(()=>enqueue(path,job()),/stop custody differs/);
    const verify=await openInitialized(path);
    try {
      assert.equal(verify.prepare("SELECT state FROM cdr_idle_release").get()!.state,"Candidate");
      assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM codex_turn_queue").get()!.n,0);
      assert.equal(verify.prepare("SELECT outcome_json FROM discord_ingress_journal").get()!.outcome_json,'{"stop_hold":null}');
    } finally {verify.close();}
  });
});
test("mirror mismatch is checked before idle mutation",async()=>{
  await fileTest(async path=>{
    const db=await openInitialized(path);
    db.prepare("INSERT INTO cdr_idle_release VALUES ('intent','owner',1,'target','turn','job',7,'Candidate','old')").run();
    db.close();
    await assert.rejects(()=>enqueueIfMirrorMatches(path,job(),{discordChannelId:9007199254740993n,targetThreadId:"target"}),MirrorMappingChangedError);
    const verify=await openInitialized(path);
    try { assert.equal(verify.prepare("SELECT state FROM cdr_idle_release").get()!.state,"Candidate"); }
    finally {verify.close();}
  });
});
test("input accessors and proxies are rejected without invoking code",async()=>{
  await fileTest(async path=>{
    let calls=0;
    const input=job();
    Object.defineProperty(input,"prompt",{enumerable:true,get(){calls++;return "bad";}});
    await assert.rejects(()=>enqueue(path,input),TypeError);
    const proxied=new Proxy(job(),{get(){calls++;throw new Error("trap");}});
    await assert.rejects(()=>enqueue(path,proxied),TypeError);
    assert.equal(calls,0);
  });
});

test("async dispatch hold blocks enqueue before writing a job",async()=>{
  const db=await memory();
  try {
    db.prepare("INSERT INTO cdr_async_questions (id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,dispatch_mode,created_at,updated_at) VALUES ('q','r',1,'target','turn','item','origin',1,7,'{}','dispatching','start',0,0)").run();
    assert.throws(()=>enqueueInTransaction(db,job()),/async question reply outcome is unconfirmed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM codex_turn_queue").get()!.n,0);
  } finally {db.close();}
});
test("unresolved fork hold cannot be bypassed by retirement on enqueue",async()=>{
  const db=await memory();
  try {
    enqueueInTransaction(db,job({jobId:"seed",targetThreadId:"seed",discordMessageId:null}));
    db.exec("CREATE TABLE IF NOT EXISTS codex_exact_thread_routing(enabled INTEGER)");
    db.prepare("INSERT INTO codex_thread_fork_handoffs (handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,created_at) VALUES ('h','target',1,2,3,'reason',0)").run();
    assert.throws(()=>enqueueInTransaction(db,job()),/app-server fork handoff is unresolved/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM codex_turn_queue WHERE job_id='j'").get()!.n,0);
  } finally {db.close();}
});
