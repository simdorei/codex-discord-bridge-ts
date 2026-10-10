import assert from "node:assert/strict";
import {test,mock} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {queueJob} from "../helpers/queue-job.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {enqueue} from "../../src/store/queue-enqueue.ts";
import {beginAppServerForkHandoff,type NewAppServerForkHandoff} from "../../src/store/fork-begin.ts";
import {forkHandoffByIdIn} from "../../src/store/fork-handoff-by-id.ts";
const request=(patch:Partial<NewAppServerForkHandoff>={}):NewAppServerForkHandoff=>({handoffId:"handoff",ambiguousJobId:null,sourceThreadId:"target",expectedGeneration:1n,quarantineReason:"reason",...patch});
async function sql(path:string,s:string):Promise<void>{const db=await openInitialized(path);try{db.exec(s);}finally{db.close();}}
async function count(path:string):Promise<number>{const db=await openInitialized(path);try{if(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='codex_thread_fork_handoffs'").get()===undefined)return 0;return Number(db.prepare("SELECT count(*) AS n FROM codex_thread_fork_handoffs").get()?.n);}finally{db.close();}}
test("begin persists mapping snapshot once and exact repetition preserves the original fence",async()=>{
  await storeFixture(async path=>{await sql(path,"INSERT INTO mirror_threads VALUES ('target','p','title',1,2,0)");const begun=await beginAppServerForkHandoff(path,request());
    assert.equal(begun.created,true);assert.equal(begun.handoff.discordThreadId,2n);assert.equal(begun.handoff.targetThreadId,null);
    await sql(path,"UPDATE mirror_threads SET discord_thread_id=9");const same=await beginAppServerForkHandoff(path,request());assert.equal(same.created,false);assert.deepEqual(same.handoff,begun.handoff);
    await assert.rejects(()=>beginAppServerForkHandoff(path,request({quarantineReason:"different"})),/different fork handoff/);
    await assert.rejects(()=>beginAppServerForkHandoff(path,request({handoffId:"other"})),/different fork handoff/);assert.equal(await count(path),1);
  });
});
test("unmapped source uses zero sentinel but explicit zero or duplicated mapping is refused",async()=>{
  await storeFixture(async path=>{const h=(await beginAppServerForkHandoff(path,request())).handoff;assert.equal(h.discordChannelId,0n);assert.equal(h.discordThreadId,0n);});
  for(const mode of ["zero","duplicate"]){await storeFixture(async path=>{
    await sql(path,mode==="zero"?"INSERT INTO mirror_threads VALUES ('target','p','t',0,0,0)":"INSERT INTO mirror_threads VALUES ('target','p','t',1,2,0),('other','p','t',3,2,0)");
    await assert.rejects(()=>beginAppServerForkHandoff(path,request()),/missing, stale, or duplicated/);assert.equal(await count(path),0);
  });}
});
test("starting lease boundary is strict and a nonblank error bypasses only the lease wait",async()=>{
  const clock=mock.method(Date,"now",()=>620000);
  try{for(const [updated,error,allowed] of [[500,"",true],[500.001,"",false],[619,"known failure",true],[619,"\u0085",false]] as const){await storeFixture(async path=>{
    await enqueue(path,queueJob());const db=await openInitialized(path);try{db.prepare("UPDATE codex_turn_queue SET state='starting',updated_at=?,last_error=?").run(updated,error);}finally{db.close();}
    const pending=beginAppServerForkHandoff(path,request({ambiguousJobId:"saved"}));if(allowed)assert.equal((await pending).created,true);else await assert.rejects(pending,/lease is still active/);
  });}}finally{clock.mock.restore();}
});
test("wrong starting identity and another running job cannot be fenced as one ambiguous request",async()=>{
  await storeFixture(async path=>{await enqueue(path,queueJob());await assert.rejects(()=>beginAppServerForkHandoff(path,request({ambiguousJobId:"saved"})),/starting job changed/);assert.equal(await count(path),0);
    await sql(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");await assert.rejects(()=>beginAppServerForkHandoff(path,request()),/another starting or running/);assert.equal(await count(path),0);
  });
});
test("source hold is checked even for a previously recorded identical request",async()=>{
  await storeFixture(async path=>{await beginAppServerForkHandoff(path,request());await sql(path,"INSERT INTO codex_dead_generation_holds(target_thread_id,runtime_id,generation,created_at) VALUES ('target','runtime',1,0)");
    await assert.rejects(()=>beginAppServerForkHandoff(path,request()),/manual review is required/);assert.equal(await count(path),1);
  });
});
test("reason normalization and identity validation retain Rust scalar boundaries and caller snapshot",async()=>{
  await storeFixture(async path=>{const r=request({quarantineReason:"\u0085"+"😀".repeat(901)+"\u0085"}),pending=beginAppServerForkHandoff(path,r);r.sourceThreadId="changed";
    const h=(await pending).handoff;assert.equal(h.sourceThreadId,"target");assert.equal(h.quarantineReason,"😀".repeat(900));
    await assert.rejects(()=>beginAppServerForkHandoff(path,request({handoffId:" bad"})),/invalid app-server fork handoff identity/);
    const db=await openInitialized(path);try{assert.equal(forkHandoffByIdIn(db,"handoff")?.sourceThreadId,"target");}finally{db.close();}
  });
});
test("conflict lookup decodes the full source row rather than treating corrupt evidence as a valid fence",async()=>{
  await storeFixture(async path=>{await beginAppServerForkHandoff(path,request());await sql(path,"UPDATE codex_thread_fork_handoffs SET last_fork_error=CAST(x'80' AS TEXT)");
    await assert.rejects(()=>beginAppServerForkHandoff(path,request({handoffId:"other"})),/Invalid text encoding in column last_fork_error/);
  });
});
