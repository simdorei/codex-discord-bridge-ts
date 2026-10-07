import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../../helpers/store-fixture.ts";
import {newReply} from "../../helpers/delivery-custody.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
import {deliverGoalProgress,recoverGoalProgress} from "../../../src/runtime/completion/goal-delivery.ts";
import {DiscordTransportFault,isCompletionHeld,type DiscordReceiptTransport} from "../../../src/runtime/completion/receipt-sender.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
async function seed(path:string,job:string|null="job",channel=1n,turn="turn"){await edit(path,db=>db.prepare("INSERT INTO codex_goal_progress(thread,turn,channel,content,job_id,last_error) VALUES ('target',?,?,'goal progress',?,'old')").run(turn,channel,job));return (await state.pendingGoalProgress(path)).find(p=>p.turn===turn)!;}
const failures={render:()=>"safe goal failure"};
test("Goal receipt is confirmed before progress retirement",async()=>storeFixture(async path=>{
  const p=await seed(path);let calls=0;await deliverGoalProgress(path,p,{async sendValidated(r){calls++;assert.equal((await state.pendingGoalProgress(path)).length,1);assert.equal(JSON.parse(r.body).content,"goal progress");return 9n;}},failures);
  assert.equal(calls,1);assert.deepEqual(await state.pendingGoalProgress(path),[]);
}));
test("legacy progress without job identity is retained without modifying error or sending",async()=>storeFixture(async path=>{
  const p=await seed(path,null);let calls=0;await assert.rejects(deliverGoalProgress(path,p,{async sendValidated(){calls++;return 9n;}},failures),/legacy goal progress/);
  assert.equal(calls,0);assert.equal((await state.pendingGoalProgress(path))[0]?.lastError,"old");
}));
test("early New hold and invalid channel do not record send errors",async()=>{
  await storeFixture(async path=>{await newReply(path);const p=await seed(path,"job",2n);await assert.rejects(deliverGoalProgress(path,p,{async sendValidated(){throw new Error("no send");}},failures),isCompletionHeld);assert.equal((await state.pendingGoalProgress(path))[0]?.lastError,"old");});
  await storeFixture(async path=>{const p=await seed(path,"job",0n);await assert.rejects(deliverGoalProgress(path,p,{async sendValidated(){throw new Error("no send");}},failures),/unsigned contract/);assert.equal((await state.pendingGoalProgress(path))[0]?.lastError,"old");});
});
test("ambiguous Goal send is recorded but never automatically sent again",async()=>storeFixture(async path=>{
  const p=await seed(path);let calls=0;const transport:DiscordReceiptTransport={async sendValidated(){calls++;throw new DiscordTransportFault("Transport","unknown");}};
  await assert.rejects(deliverGoalProgress(path,p,transport,failures));await assert.rejects(deliverGoalProgress(path,p,transport,failures));assert.equal(calls,1);assert.equal((await state.pendingGoalProgress(path))[0]?.lastError,"safe goal failure");
}));
test("Goal error recording failure takes precedence over transport failure",async()=>storeFixture(async path=>{
  const p=await seed(path);await edit(path,db=>db.exec("CREATE TRIGGER no_error BEFORE UPDATE ON codex_goal_progress BEGIN SELECT RAISE(ABORT,'cannot save error'); END"));
  await assert.rejects(deliverGoalProgress(path,p,{async sendValidated(){throw new DiscordTransportFault("Transport","unknown");}},failures),/cannot save error/);
}));
test("Goal completion failure reuses confirmed receipt on recovery",async()=>storeFixture(async path=>{
  const p=await seed(path);await edit(path,db=>db.exec("CREATE TRIGGER no_finish BEFORE DELETE ON codex_goal_progress BEGIN SELECT RAISE(ABORT,'cannot finish'); END"));let calls=0;const t:DiscordReceiptTransport={async sendValidated(){calls++;return 9n;}};
  await assert.rejects(deliverGoalProgress(path,p,t,failures),/cannot finish/);assert.equal((await state.pendingGoalProgress(path))[0]?.lastError,"old");
  await edit(path,db=>db.exec("DROP TRIGGER no_finish"));await recoverGoalProgress(path,t,failures);assert.equal(calls,1);assert.deepEqual(await state.pendingGoalProgress(path),[]);
}));
test("recovery continues later progress after legacy failure",async()=>storeFixture(async path=>{
  await seed(path,null,1n,"legacy");await seed(path,"job",1n,"new");let calls=0;await assert.rejects(recoverGoalProgress(path,{async sendValidated(){calls++;return 9n;}},failures),/legacy goal progress/);assert.equal(calls,1);assert.deepEqual((await state.pendingGoalProgress(path)).map(p=>p.turn),["legacy"]);
}));
