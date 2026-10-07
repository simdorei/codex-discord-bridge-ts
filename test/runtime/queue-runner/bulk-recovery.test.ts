import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {queueJob} from "../../helpers/queue-job.ts";
import {QueueStartCoordinator,BackendFailureError,type QueueStartBackend} from "../../../src/runtime/queue-runner/start-coordinator.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {markManagedTargetIn} from "../../../src/store/queue-managed-target.ts";
const backend=(patch:Partial<QueueStartBackend>={}):QueueStartBackend=>({generation:()=>2n,residentInstanceId:()=>"resident",requiresAppServerFork:()=>false,activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async c=>`turn:${c.targetThreadId}`,...patch});
async function sql(path:string,s:string):Promise<void>{const db=await openInitialized(path);try{db.exec(s);}finally{db.close();}}
test("bulk observes active targets before writer work and one unavailable read does not block another safe target",async()=>{
  await storeFixture(async path=>{await state.enqueue(path,queueJob({jobId:"a",targetThreadId:"a"}));await state.enqueue(path,queueJob({jobId:"b",targetThreadId:"b"}));
    await sql(path,"UPDATE codex_turn_queue SET state='running',turn_id='old',execution_generation=1,turn_observation_generation=1 WHERE job_id='a'");const calls:string[]=[];
    const queue=new QueueStartCoordinator(path,backend({readTurns:async t=>{calls.push(`read:${t}`);if(t==="a")throw new BackendFailureError({kind:"Other",ambiguous:false,message:"read unavailable"});return [];},resumeThread:async t=>{calls.push(`resume:${t}`);},startClaimedTurn:async c=>{calls.push(`start:${c.targetThreadId}`);return `turn:${c.targetThreadId}`;}}),{clock:()=>1000});
    const report=await queue.recover();assert.deepEqual(calls,["read:a","resume:b","read:b","start:b"]);assert.deepEqual([...report.readUnavailableTargets],["a"]);assert.equal(report.started,1);assert.equal(report.adopted,1);
    assert.equal((await state.listFiltered(path,"a",null))[0]?.appServerGeneration,1n);
  });
});
test("cold starting attempt with empty history remains unknown and is not automatically replayed",async()=>{
  await storeFixture(async path=>{await state.enqueue(path,queueJob({targetThreadId:"a"}));await sql(path,"UPDATE codex_turn_queue SET state='starting',attempt_count=1");let starts=0,resumes=0;
    const queue=new QueueStartCoordinator(path,backend({resumeThread:async()=>{resumes++;},startClaimedTurn:async()=>{starts++;return "turn";}}),{clock:()=>1000});
    assert.equal((await queue.recover()).unresolved,1);assert.equal((await queue.recover()).unresolved,1);assert.equal(starts,0);assert.equal(resumes,0);
    const job=(await state.listFiltered(path,"a",null))[0]!;assert.equal(job.state,"Starting");assert.equal(job.attemptCount,1n);assert.match(job.lastError,/empty history does not authorize retry/);
  });
});
test("unmanaged preparation is followed by a fresh target inventory, preserving the same job on the destination",async()=>{
  await storeFixture(async path=>{await state.enqueue(path,queueJob({jobId:"job",targetThreadId:"source"}));const calls:string[]=[];
    const queue=new QueueStartCoordinator(path,backend({requiresAppServerFork:()=>true,forkThread:async t=>{calls.push(`fork:${t}`);return "new";},resumeThread:async t=>{calls.push(`resume:${t}`);},readTurns:async t=>{calls.push(`read:${t}`);return [];},startClaimedTurn:async c=>{calls.push(`start:${c.targetThreadId}`);assert.equal(c.jobId,"job");return "turn";}}),{clock:()=>1000});
    const report=await queue.recover();assert.deepEqual(calls,["fork:source","resume:new","read:new","start:new"]);assert.equal(report.started,1);assert.equal((await state.listFiltered(path,"new",null))[0]?.jobId,"job");
  });
});
test("active-writer fork second pass returns its own counters while retaining the original conflict identity",async()=>{
  await storeFixture(async path=>{for(const id of ["a","b"])await state.enqueue(path,queueJob({jobId:id,targetThreadId:id}));const db=await openInitialized(path);try{markManagedTargetIn(db,"a",1n,0);markManagedTargetIn(db,"b",1n,0);}finally{db.close();}
    const started=new Set<string>(),forks:string[]=[];const queue=new QueueStartCoordinator(path,backend({requiresAppServerFork:()=>true,
      resumeThread:async t=>{if(t==="a")throw new BackendFailureError({kind:"ActiveWriter",ambiguous:false,message:"thread/resume already has an active writer"});},
      readTurns:async t=>started.has(t)?[{turnId:`turn:${t}`,status:"InProgress"}]:[],
      forkThread:async t=>{forks.push(t);return `${t}-new`;},startClaimedTurn:async c=>{started.add(c.targetThreadId);return `turn:${c.targetThreadId}`;}}),{clock:()=>1000});
    const report=await queue.recover();assert.deepEqual(forks,["a"]);assert.deepEqual([...started],["b","a-new"]);assert.equal(report.started,1);assert.equal(report.adopted,0);assert.deepEqual([...report.activeWriterTargets],["a"]);assert.equal(report.mutationUnavailableTargets.has("a"),false);
  });
});
test("simultaneous bulk passes share target ownership and cannot dispatch a pending job twice",async()=>{
  await storeFixture(async path=>{await state.enqueue(path,queueJob());let starts=0;const queue=new QueueStartCoordinator(path,backend({readTurns:async()=>starts?[{turnId:"turn",status:"InProgress"}]:[],startClaimedTurn:async()=>{starts++;return "turn";}}),{clock:()=>1000});
    await Promise.all([queue.recover(),queue.recover()]);assert.equal(starts,1);assert.equal(queue.locks.activeTargetCount,0);
  });
});
