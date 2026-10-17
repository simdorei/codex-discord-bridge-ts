import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
import {MirrorOrphanCleanup} from '../../../src/runtime/mirror-sync/orphan-cleanup.ts';
const started=2000000000, fresh=()=>new AbortController().signal;
const thread=(id:string,owner='9')=>({id,type:11,guild_id:'1',parent_id:'2',name:'fixture',owner_id:owner});
const page=(threads:unknown[])=>({threads,members:[],has_more:false});
async function fixture(run:(path:string,store:NativeMirrorStore,cleanup:MirrorOrphanCleanup,state:{threads:unknown[];missing:boolean;deleteStatus:number;deleted:string[];onInventory:(()=>Promise<void>)|null;onDelete:(()=>Promise<void>)|null})=>Promise<void>){
 await storeFixture(async path=>{
  const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_projects VALUES(?,?,?,?)').run('p','project',2n,started+1);}finally{db.close();}
  const state={threads:[] as unknown[],missing:false,deleteStatus:204,deleted:[] as string[],onInventory:null as (()=>Promise<void>)|null,onDelete:null as (()=>Promise<void>)|null};
  const server=http.createServer((q,r)=>{void (async()=>{
   if(q.method==='DELETE'){state.deleted.push(q.url!);await state.onDelete?.();r.writeHead(state.deleteStatus);r.end(state.deleteStatus===204?'':'{"code":0,"message":"failed"}');return;}
   if(q.url!.endsWith('users/@me')){r.end('{"id":"9","username":"bot","discriminator":"0","avatar":null,"bot":true}');return;}
   if(q.url!.includes('threads/active')){await state.onInventory?.();r.end(JSON.stringify(page(state.threads)));return;}
   if(q.url!.includes('threads/archived')){r.end(JSON.stringify(page([])));return;}
   if(state.missing){r.writeHead(404);r.end('{"code":10003,"message":"gone"}');return;}
   r.end('{"id":"2","type":0,"guild_id":"1","name":"project"}');
  })().catch(()=>{r.writeHead(500);r.end('{"code":0,"message":"fixture failed"}');});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');
  const client=await DiscordChannelClient.create({token:null,report:()=>{},testOrigin:`http://127.0.0.1:${address.port}/api/v10/`}),store=new NativeMirrorStore(path);
  try{await run(path,store,new MirrorOrphanCleanup(store,client),state);}finally{await client.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
 });
}
async function sql(path:string,text:string){const db=await openInitialized(path);try{db.exec(text);}finally{db.close();}}
test('only old bot-owned unmapped orphan is deleted; new, foreign and mapped rooms survive',async()=>fixture(async(path,store,cleanup,state)=>{
 const recent=(((BigInt(started)*1000n)-1420070400000n)<<22n).toString();state.threads=[thread('3'),thread('4','8'),thread('5'),thread(recent)];
 await sql(path,"INSERT INTO mirror_threads VALUES('t','p','title',2,5,1)");
 assert.deepEqual(await cleanup.run(1n,started,fresh()),[1,0]);assert.deepEqual(state.deleted,['/api/v10/channels/3']);assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),'deleted');assert.equal(await store.execute({kind:'IsMapped',args:[5n]}),true);
}));
test('mapping committed during remote inventory excludes the newly owned room',async()=>fixture(async(path,_store,cleanup,state)=>{
 state.threads=[thread('3')];state.onInventory=()=>sql(path,"INSERT OR IGNORE INTO mirror_threads VALUES('t','p','title',2,3,1)");
 assert.deepEqual(await cleanup.run(1n,started,fresh()),[0,0]);assert.deepEqual(state.deleted,[]);
}));
test('ingress prevents orphan deletion and no cleanup fence is started',async()=>fixture(async(path,store,cleanup,state)=>{
 state.threads=[thread('3')];await sql(path,"INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,target_thread_id,state,phase,confirmation_delivered,payload_json,created_at,updated_at) VALUES('i','message',3,1,NULL,'staged','received',0,'{}',1,1)");
 await assert.rejects(cleanup.run(1n,started,fresh()));assert.deepEqual(state.deleted,[]);assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),null);
}));
test('empty stale project is fenced and deleted before its mapping retires',async()=>fixture(async(path,store,cleanup,state)=>{
 await sql(path,'UPDATE mirror_projects SET updated_at=1');assert.deepEqual(await cleanup.run(1n,started,fresh()),[0,1]);assert.deepEqual(state.deleted,['/api/v10/channels/2']);assert.equal(await store.execute({kind:'IsMapped',args:[2n]}),false);assert.equal(await store.execute({kind:'CleanupPhase',args:[2n]}),'deleted');
}));
test('foreign thread in obsolete project blocks deletion of the parent',async()=>fixture(async(path,store,cleanup,state)=>{
 await sql(path,'UPDATE mirror_projects SET updated_at=1');state.threads=[thread('3','8')];await assert.rejects(cleanup.run(1n,started,fresh()),/protected threads/);assert.deepEqual(state.deleted,[]);assert.equal(await store.execute({kind:'IsMapped',args:[2n]}),true);
}));
test('missing obsolete project gets a tombstone without DELETE',async()=>fixture(async(path,store,cleanup,state)=>{
 await sql(path,'UPDATE mirror_projects SET updated_at=1');state.missing=true;assert.deepEqual(await cleanup.run(1n,started,fresh()),[0,1]);assert.deepEqual(state.deleted,[]);assert.equal(await store.execute({kind:'CleanupPhase',args:[2n]}),'deleted');
}));
test('mapping updated during final inventory cannot be retired by stale cutoff',async()=>fixture(async(path,store,cleanup,state)=>{
 await sql(path,'UPDATE mirror_projects SET updated_at=1');let inventories=0;state.onInventory=async()=>{if(++inventories===2)await sql(path,`UPDATE mirror_projects SET updated_at=${started+1}`);};await assert.rejects(cleanup.run(1n,started,fresh()),/mapping changed/);assert.equal(await store.execute({kind:'IsMapped',args:[2n]}),true);assert.equal(state.deleted.length,1);
}));
test('unknown DELETE keeps durable fence and never reports successful cleanup',async()=>fixture(async(_path,store,cleanup,state)=>{
 state.threads=[thread('3')];state.deleteStatus=500;await assert.rejects(cleanup.run(1n,started,fresh()),/durable fence retained/);assert.equal(await store.execute({kind:'CleanupPhase',args:[3n]}),'deleting');assert.equal(state.deleted.length,1);
}));
