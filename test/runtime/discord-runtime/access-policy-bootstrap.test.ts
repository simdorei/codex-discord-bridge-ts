import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {buildRuntimeAccessPolicy} from '../../../src/runtime/discord-runtime/access-policy-bootstrap.ts';import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';import type {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000};const config=()=>({allowedChannelIds:new Set([1n]),allowedUserIds:new Set([2n]),allowAllChannels:false});
const allowed=(p:InteractionAccessPolicy,c:bigint,u=2n)=>p.evaluate(decodeGatewayInteraction(JSON.stringify({application_id:'4',id:'3',token:'fixture',type:2,authorizing_integration_owners:{},channel_id:String(c),user:{id:String(u),username:'u',discriminator:'0001'},data:{id:'9',name:'help',type:1}}))).kind==='Allowed';
test('startup access policy binds static users/channels and native mirror rooms before gateway use',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec("INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at)VALUES('thread','project','title',8,7,1)");}finally{db.close();}
 const p=await buildRuntimeAccessPolicy(config(),path,limits);for(const id of [1n,7n,8n])assert.equal(allowed(p,id),true);assert.equal(allowed(p,9n),false);assert.equal(allowed(p,7n,3n),false);assert.equal(ownedWorkerUsage().Background,0);
}));
test('native refresh captures static sets before await and does not invoke overridden iterators',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const c=config();let hooks=0;Object.defineProperty(c.allowedChannelIds,Symbol.iterator,{value(){hooks++;throw Error('iterator');}});
 const pending=buildRuntimeAccessPolicy(c,path,limits);c.allowedChannelIds.clear();c.allowedChannelIds.add(99n);c.allowedUserIds.clear();c.allowAllChannels=true;const p=await pending;assert.equal(hooks,0);assert.equal(allowed(p,1n),true);assert.equal(allowed(p,99n),false);assert.equal(allowed(p,1n,3n),false);
}));
test('startup does not initialize missing policy store or treat overload/failure as allow-all fallback',async()=>storeFixture(async path=>{
 await assert.rejects(buildRuntimeAccessPolicy({...config(),allowAllChannels:true},path,limits));assert.equal(existsSync(path),false);
 const db=await openInitialized(path);try{db.exec("INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at)VALUES('a','project','a',8,7,1),('b','project','b',9,10,2)");}finally{db.close();}
 await assert.rejects(buildRuntimeAccessPolicy(config(),path,{...limits,maxRows:1n}));
}));
test('forged static sets, oversized policy and preabort fail before hooks or native IO',async()=>storeFixture(async path=>{
 let hooks=0;const c=config();await assert.rejects(buildRuntimeAccessPolicy({...c,allowedChannelIds:new Proxy(c.allowedChannelIds,{get(){hooks++;throw Error('proxy');}})},path,limits),TypeError);
 await assert.rejects(buildRuntimeAccessPolicy(Object.defineProperty(c,'allowAllChannels',{get(){hooks++;return true;}}),path,limits),TypeError);
 await assert.rejects(buildRuntimeAccessPolicy({...config(),allowedChannelIds:new Set(Array.from({length:4097},(_,i)=>BigInt(i)))},path,limits),RangeError);
 const a=new AbortController();a.abort('pre');await assert.rejects(buildRuntimeAccessPolicy(c,path,limits,a.signal),e=>e==='pre');assert.equal(hooks,0);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Background,0);
}));
