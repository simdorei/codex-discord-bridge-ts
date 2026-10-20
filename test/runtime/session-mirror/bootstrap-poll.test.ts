import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {dirname,join} from 'node:path';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {createSessionMirrorHttpTransport} from '../../../src/runtime/discord-runtime/session-mirror-http.ts';
import {MirrorTargetBootstrapCoordinator} from '../../../src/runtime/session-mirror/bootstrap-coordinator.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import {NativeMirrorStartupIntentStore} from '../../../src/runtime/session-mirror/startup-intent-store.ts';
import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';

const context={maxBytes:1048576,maxRecords:10000,maxRecordBytes:262144,maxWindowBytes:65536,maxTurnBytes:16384,timeoutMs:5000};
const pollOptions={read:{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}};
const discovery={...pollOptions.ownership,maxTargets:32n,maxOutputBytes:1048576};
const line=(value:unknown)=>JSON.stringify(value)+'\n';
const event=(message:string)=>line({type:'event_msg',payload:{type:'agent_message',message}});
const turn=(turn_id:string)=>line({type:'turn_context',payload:{turn_id}});
const history=turn('older-turn')+event('historical first message')+turn('current-turn')+event('historical second message');
const bootstrap=(databasePath:string,rolloutPath:string,operationId='bootstrap')=>new MirrorTargetBootstrapCoordinator({
 databasePath,thread:'thread',rolloutPath,channel:42n,operationId,createdAt:1.25,context,totalTimeoutMs:10000,
});

async function fixture(run:(path:string,file:string,cursor:NativeMirrorCursorStore,intents:NativeMirrorStartupIntentStore)=>Promise<void>):Promise<void>{
 await storeFixture(async path=>{
  const file=join(dirname(path),'rollout.jsonl');await writeFile(file,history);
  const db=await openInitialized(path);
  try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);}finally{db.close();}
  const cursor=new NativeMirrorCursorStore(path),intents=new NativeMirrorStartupIntentStore(path);
  try{
   await cursor.initializeSchema();await intents.initializeSchema();
   await run(path,file,cursor,intents);
  }finally{await intents.close();await cursor.close();}
 });
}

test('bootstrap skips historical events, delivers the first append once over real local HTTP, and leaves repeated EOF polls idle',{timeout:30000},async()=>fixture(async(path,file,cursor,intents)=>{
 const seen:{method:string;path:string;body:string;authorization:string|undefined}[]=[];
 const message={attachments:[],author:{id:'1',username:'fixture',discriminator:'0'},channel_id:'42',content:'In progress\n\nfirst append',embeds:[],id:'123',type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false};
 const server=createServer((req,res)=>{
  let body='';req.on('data',part=>body+=String(part));
  req.on('end',()=>{seen.push({method:req.method!,path:req.url!,body,authorization:req.headers.authorization});res.end(JSON.stringify(message));});
 });
 let client:DiscordChannelClient|undefined;
 const owner=bootstrap(path,file);
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  client=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${address.port}/api/v10/`,report:()=>{}});
  const transport=createSessionMirrorHttpTransport(client);
  const result=await owner.run();
  assert.equal(result.kind,'Initialized');assert.equal(result.reconciled,false);
  assert.equal(result.cursor.anchor.offset,BigInt(Buffer.byteLength(history)));
  assert.equal(result.cursor.turn,'current-turn');assert.equal(result.cursor.revision,1n);
  assert.equal(result.cursor.operationId,'bootstrap');assert.equal(result.cursor.updatedAt,1.25);
  assert.equal(await intents.read('thread'),null);assert.deepEqual(await cursor.read('thread'),result.cursor);
  assert.equal(owner.busy,false);assert.equal(seen.length,0);

  const jobs=(await discoverMirrorStore(path,discovery)).jobs;
  const poll=()=>pollBoundMirrorTarget(path,{id:'thread',rolloutPath:file},42n,jobs,pollOptions,transport);
  assert.deepEqual(await poll(),{targets:0n,events:0n,sent:0n});
  assert.equal(seen.length,0);assert.deepEqual(await cursor.read('thread'),result.cursor);

  const appended=event('first append');await appendFile(file,appended);
  assert.deepEqual(await poll(),{targets:1n,events:1n,sent:1n});
  assert.equal(seen.length,1);assert.equal(seen[0]!.authorization,undefined);
  assert.equal(seen[0]!.method,'POST');assert.equal(seen[0]!.path,'/api/v10/channels/42/messages');
  const body=JSON.parse(seen[0]!.body);
  assert.equal(body.content,'In progress\n\nfirst append');assert.equal(body.enforce_nonce,true);
  assert.deepEqual(body.allowed_mentions,{parse:[]});assert.match(seen[0]!.body,/"nonce":\d+/);
  const committed=await cursor.read('thread');assert.ok(committed);
  assert.equal(committed.revision,2n);assert.equal(committed.turn,'current-turn');
  assert.equal(committed.anchor.offset,BigInt(Buffer.byteLength(history+appended)));
  const db=await openInitialized(path);
  try{
   const receipts=db.prepare('SELECT message_id,retryable,blocked_reason FROM codex_delivery_receipts').all();
   assert.equal(receipts.length,1);assert.equal(receipts[0]!.message_id,'123');
   assert.equal(receipts[0]!.retryable,0);assert.equal(receipts[0]!.blocked_reason,null);
  }finally{db.close();}

  for(let repeat=0;repeat<2;repeat++){
   assert.deepEqual(await poll(),{targets:0n,events:0n,sent:0n});
   assert.equal(seen.length,1);assert.deepEqual(await cursor.read('thread'),committed);
  }
  assert.equal(client.activeRequests,0);assert.equal(ownedWorkerUsage().Background,0);assert.equal(activeMirrorFileReads(),0);
 }finally{
  await owner.close();await client?.close();if(client)assert.equal(client.ownedSockets,0);
  server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
 }
}));

test('reconstructed bootstrap returns the existing bound cursor without scanning a missing rollout or replacing the original cutoff',{timeout:20000},async()=>fixture(async(path,file,cursor,intents)=>{
 const first=bootstrap(path,file);
 let original;
 try{original=(await first.run()).cursor;}finally{await first.close();}
 await appendFile(file,event('not part of the original cutoff'));await rm(file);
 const restarted=bootstrap(path,file,'different-restart-operation');
 try{
  assert.deepEqual(await restarted.run(),{kind:'Existing',cursor:original,reconciled:false});
  assert.deepEqual(await cursor.read('thread'),original);assert.equal(await intents.read('thread'),null);
  assert.equal(restarted.busy,false);assert.equal(ownedWorkerUsage().Background,0);assert.equal(activeMirrorFileReads(),0);
 }finally{await restarted.close();}
}));
