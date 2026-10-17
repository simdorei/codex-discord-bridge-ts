import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {createBusyChoice,getBusyChoice,claimBusyChoice,releaseBusyChoiceClaim,cleanupBusyChoices,busyChoiceCounts,type NewBusyChoice} from "../../src/store/busy-choice-store.ts";
import {admitBusyQueue} from "../../src/store/prompt-intake-busy.ts";
const input=():NewBusyChoice=>({ownerUserId:2n,channelId:1n,targetThreadId:"target",prompt:"raw",allowSteer:true,now:10,timeToLive:100});
async function sql(path:string,s:string):Promise<void>{const db=await openInitialized(path);try{db.exec(s);}finally{db.close();}}
test("choice creation freezes route, supports exact get and ends at the expiry boundary",async()=>{
  await storeFixture(async path=>{const id=await createBusyChoice(path,input());assert.match(id,/^[a-f0-9]{24}$/);
    const c=await getBusyChoice(path,id,109.999);assert.ok(c);assert.equal(c.expiresAt,110);assert.equal(c.allowSteer,true);
    assert.deepEqual(await busyChoiceCounts(path,10),[1n,0n]);assert.equal(await getBusyChoice(path,id,110),null);assert.deepEqual(await busyChoiceCounts(path,110),[0n,0n]);
  });
});
test("claimed choices are retained until expiry and definite rejection can release the same choice",async()=>{
  await storeFixture(async path=>{const id=await createBusyChoice(path,input());assert.equal(await claimBusyChoice(path,id,11),true);assert.equal(await claimBusyChoice(path,id,12),false);
    assert.equal(await getBusyChoice(path,id,12),null);assert.deepEqual(await busyChoiceCounts(path,12),[0n,1n]);
    assert.equal(await releaseBusyChoiceClaim(path,id),true);assert.equal(await releaseBusyChoiceClaim(path,id),false);assert.ok(await getBusyChoice(path,id,12));
    assert.equal(await cleanupBusyChoices(path,109),0n);assert.equal(await cleanupBusyChoices(path,110),1n);
  });
});
test("inferred mirrored route is fixed and can be admitted only while that mapping matches",async()=>{
  await storeFixture(async path=>{await sql(path,"INSERT INTO mirror_threads VALUES ('target','p','title',9,1,0)");const id=await createBusyChoice(path,input());const c=await getBusyChoice(path,id,11);assert.ok(c);
    await assert.rejects(()=>createBusyChoice(path,input(),false),/original busy prompt route changed/);
    assert.ok((await admitBusyQueue(path,c,"target",true,"confirmed",12)).intake);
  });
});
test("choice creation copies values before await and rejects getters without running them",async()=>{
  await storeFixture(async path=>{const source=input(),pending=createBusyChoice(path,source);source.prompt="changed";source.ownerUserId=9n;
    const id=await pending;assert.equal((await getBusyChoice(path,id,11))?.prompt,"raw");
    let calls=0;const bad=input();Object.defineProperty(bad,"prompt",{get(){calls++;return "bad";},enumerable:true});
    await assert.rejects(()=>createBusyChoice(path,bad),/own busy choice field/);assert.equal(calls,0);
  });
});
test("expired choice payload corruption is decoded before cleanup and cannot be silently deleted",async()=>{
  await storeFixture(async path=>{const id=await createBusyChoice(path,input());await sql(path,"UPDATE busy_choices SET prompt=CAST(x'80' AS TEXT)");
    await assert.rejects(()=>getBusyChoice(path,id,200),/Invalid text encoding in column prompt/);
    assert.deepEqual(await busyChoiceCounts(path,200),[0n,1n]);
  });
});
