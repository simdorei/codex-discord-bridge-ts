import assert from "node:assert/strict";
import {test} from "node:test";
import {storeFixture as temporary} from "../helpers/store-fixture.ts";
import type {DatabaseSync} from "node:sqlite";
import {StateAccessFacade} from "../../src/store/state-access-facade.ts";
import {usingInitializedStore} from "../../src/store/owned-scope.ts";

test("central state facade initializes and persists exact observation scope across owned connections",async()=>temporary(async path=>{
  const s={ownerId:"before-await",generation:9007199254740993n},started=StateAccessFacade.activateObservation(path,s);s.ownerId="mutated";await started;const original={ownerId:"before-await",generation:s.generation};assert.equal(await StateAccessFacade.observationScopeVerified(path,original,0n),true);assert.equal(await StateAccessFacade.observationScopeVerified(path,s,0n),false);await StateAccessFacade.discoverObservation(path,original,2n);const gap=await StateAccessFacade.nextObservationGap(path,original);assert.equal(gap!.last,2n);assert.equal(gap!.scope.generation,s.generation);await StateAccessFacade.markUnknownObservation(path,original,"unattributed");assert.equal(await StateAccessFacade.observationScopeVerified(path,original,0n),false);
}));
test("central owned store scope closes handles after success and preserves primary callback failure",async()=>temporary(async path=>{
  let success:DatabaseSync|undefined,failed:DatabaseSync|undefined;assert.equal(await usingInitializedStore(path,db=>{success=db;return 42;}),42);assert.equal(success!.isOpen,false);const sentinel={};await assert.rejects(usingInitializedStore(path,db=>{failed=db;throw sentinel;}),e=>e===sentinel);assert.equal(failed!.isOpen,false);let calls=0;await assert.rejects(usingInitializedStore(path,async()=>{calls++;}),/synchronous/);assert.equal(calls,0);await assert.rejects(usingInitializedStore(path,db=>{db.exec("BEGIN IMMEDIATE");db.exec("CREATE TABLE must_rollback(v INTEGER)");return true;}),/active transaction/);assert.equal(await usingInitializedStore(path,db=>db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='must_rollback'").get()!.n),0);await assert.rejects(usingInitializedStore(path,db=>{db.close();}),/closed inside/);
}));
