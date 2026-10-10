import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {claimComponent,releaseComponentClaim,cleanupComponentClaims,componentClaimCounts} from "../../src/store/component-claims.ts";
test("component claim is unique until its exact expiration and reacquires atomically",async()=>{
  await storeFixture(async path=>{const results=await Promise.all([claimComponent(path,"key",10,20),claimComponent(path,"key",10,20)]);assert.equal(results.filter(Boolean).length,1);
    assert.equal(await claimComponent(path,"key",29.999,30),false);assert.deepEqual(await componentClaimCounts(path,30),[0n,1n]);
    assert.equal(await claimComponent(path,"key",30,10),true);assert.deepEqual(await componentClaimCounts(path,30),[1n,0n]);
    assert.equal(await releaseComponentClaim(path,"key"),true);assert.equal(await releaseComponentClaim(path,"key"),false);
  });
});
test("failed claim insertion rolls back expiration cleanup instead of losing existing receipts",async()=>{
  await storeFixture(async path=>{await claimComponent(path,"old",0,1);const db=await openInitialized(path);try{db.exec("CREATE TRIGGER refuse_new_claim BEFORE INSERT ON persistent_component_claims BEGIN SELECT RAISE(ABORT,'failure'); END");}finally{db.close();}
    await assert.rejects(()=>claimComponent(path,"new",2,10),/failure/);assert.deepEqual(await componentClaimCounts(path,2),[0n,1n]);
  });
});
test("cleanup returns exact affected count and does not remove a future receipt",async()=>{
  await storeFixture(async path=>{await claimComponent(path,"a",0,10);await claimComponent(path,"b",0,20);
    assert.equal(await cleanupComponentClaims(path,10),1n);assert.deepEqual(await componentClaimCounts(path,10),[1n,0n]);assert.equal(await cleanupComponentClaims(path,20),1n);
  });
});
