import assert from "node:assert/strict";
import {test} from "node:test";
import type {DatabaseSync} from "node:sqlite";
import {storeFixture} from "../helpers/store-fixture.ts";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {StateAccessFacade as state} from "../../src/store/state-access-facade.ts";
import {getIngressIn} from "../../src/store/ingress-read.ts";
import {getOwn} from "../../src/store/async-resolution-json-helpers.ts";
import type {NewIngress} from "../../src/store/ingress-types.ts";
const request=(overrides:Partial<NewIngress>={}):NewIngress=>({ingressId:"original",kind:"interaction",eventId:3n,applicationId:4n,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n,work:{Slash:{name:"ask",values:{prompt:{String:"hello"}}}}},targetThreadId:null,canonicalOwner:null,now:1,...overrides});
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
const read=(path:string)=>edit(path,db=>getIngressIn(db,"original")!);
async function start(path:string):Promise<void>{await state.admitIngress(path,request({kind:"action",payload:{command:"new",prompt:"hello"}}));assert.equal(await state.beginIngressThreadStart(path,"original",7n,2),true);}
test("mapped slash admission freezes actual mirror without selected-target guessing",async()=>{
  for(const name of ["ask","interview"])await storeFixture(async path=>{await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('mapped','p','title',10,1,1)"));const r=request({payload:{version:1n,work:{Slash:{name,values:{prompt:{String:"hello"}}}}}});
    const first=await state.admitMappedSlashIngress(path,r);assert.equal(first.record?.targetThreadId,"mapped");
    await edit(path,db=>db.exec("UPDATE mirror_threads SET codex_thread_id='changed'"));const repeat=await state.admitMappedSlashIngress(path,r);assert.equal(repeat.created,false);assert.equal(repeat.record?.targetThreadId,"mapped");
  });
  await storeFixture(async path=>assert.equal((await state.admitMappedSlashIngress(path,request())).record?.targetThreadId,null));
});
test("unsupported slash envelopes and ambiguous rooms do not create journal entries",async()=>{
  await storeFixture(async path=>{
    for(const r of [request({targetThreadId:"injected"}),request({kind:"message"}),request({payload:{version:2n,work:{Slash:{name:"ask",values:{prompt:{String:"hello"}}}}}}),request({payload:{version:1n,work:{Slash:{name:"new",values:{prompt:{String:"hello"}}}}}})])await assert.rejects(state.admitMappedSlashIngress(path,r),/unsupported mapped slash/);
    await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('a','p','title',10,1,1),('b','p','title',10,1,1)"));await assert.rejects(state.admitMappedSlashIngress(path,request()),/multiple Codex threads/);await edit(path,db=>assert.equal(db.prepare("SELECT count(*) AS n FROM discord_ingress_journal").get()?.n,0));
  });
});
test("new creation context binds original room and generation exactly once",async()=>{
  await storeFixture(async path=>{await start(path);await assert.rejects(state.recordIngressNewCreation(path,"original",8n,"C:/work",1n,3),/matching unwritten attempt/);
    await state.recordIngressNewCreation(path,"original",7n,"C:/work",1n,3);assert.deepEqual(getOwn((await read(path)).outcome,"new_creation"),{version:1n,cwd:"C:/work",origin_channel_id:1n});
    await assert.rejects(state.recordIngressNewCreation(path,"original",7n,"C:/other",1n,4),/matching unwritten attempt/);await state.recordIngressCreatedThread(path,"original",7n,"created",5);
    await assert.rejects(state.recordIngressNewCreation(path,"original",7n,null,1n,6),/matching unwritten attempt/);
  });
});
test("post-admission route changes refuse context without overwriting original attempt",async()=>{
  await storeFixture(async path=>{await start(path);await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('mapped','p','title',10,1,1)"));await assert.rejects(state.recordIngressNewCreation(path,"original",7n,"C:/work",1n,3),/mapping changed/);const record=await read(path);assert.equal(record.phase,"thread/start");assert.equal(getOwn(record.outcome,"new_creation"),undefined);});
});
test("creation accepts null cwd, rejects blank cwd or room and ignores only display changes",async()=>{
  await storeFixture(async path=>{await edit(path,db=>db.exec("INSERT INTO mirror_threads VALUES ('mapped','p','title',10,1,1)"));await start(path);await edit(path,db=>db.exec("UPDATE mirror_threads SET thread_title='new title',updated_at=99"));
    assert.throws(()=>state.recordIngressNewCreation(path,"original",7n,"\u0085",1n,3),/invalid new creation/);assert.throws(()=>state.recordIngressNewCreation(path,"original",7n,null,0n,3),/invalid new creation/);
    await state.recordIngressNewCreation(path,"original",7n,null,1n,3);assert.deepEqual(getOwn((await read(path)).outcome,"new_creation"),{version:1n,cwd:null,origin_channel_id:1n});
  });
});
