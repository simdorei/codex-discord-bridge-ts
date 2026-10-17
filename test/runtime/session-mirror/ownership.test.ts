import test from 'node:test';import assert from 'node:assert/strict';
import {storeFixture} from '../../helpers/store-fixture.ts';import {queueJob} from '../../helpers/queue-job.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';import {enqueue} from '../../../src/store/queue-enqueue.ts';
import {userOriginMarker} from '../../../src/store/mirror-origin.ts';import {collectSessionItems} from '../../../src/runtime/session-mirror/collect.ts';
import {discordActiveMirrorTurn,discordOriginMirrorUser,currentDiscordMirrorOwner,MirrorOwnershipPendingError} from '../../../src/runtime/session-mirror/ownership.ts';
const item=(turn:string|null='turn',kind='user_message',text='prompt')=>collectSessionItems('target',[{type:'event_msg',payload:{type:kind,message:text}}],'Send',turn).items[0]!;
async function edit(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql);}finally{db.close();}}
test('same queued text without attached turn is not Discord origin evidence',async()=>storeFixture(async path=>{
 assert.equal(await discordOriginMirrorUser(path,'target',item(),[queueJob()]),false);
 assert.equal(await discordOriginMirrorUser(path,'target',item(),[queueJob({turnId:'different',state:'Running'})]),false);
 assert.equal(await discordOriginMirrorUser(path,'target',item(),[queueJob({turnId:'turn',targetThreadId:'other'})]),false);
}));
test('attached prompt match preserves Rust trim and optional item-turn semantics',async()=>storeFixture(async path=>{
 const job=queueJob({turnId:'turn',prompt:'\u0085prompt\u0085'});
 assert.equal(await discordOriginMirrorUser(path,'target',item(),[job]),true);
 assert.equal(await discordOriginMirrorUser(path,'target',item(null),[job]),true);
 assert.equal(await discordOriginMirrorUser(path,'target',item('turn','user_message','\uFEFFprompt'),[job]),false);
 assert.equal(await discordOriginMirrorUser(path,'target',item('turn','agent_message'),[job]),false);
}));
test('durable user marker survives removed queue but stays turn/thread/content scoped',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.prepare('INSERT INTO codex_session_mirror_events VALUES(?,?,1)').run(userOriginMarker('target','turn','prompt'),'target');}finally{db.close();}
 assert.equal(await discordOriginMirrorUser(path,'target',item(),[]),true);
 assert.equal(await discordOriginMirrorUser(path,'target',item('other'),[]),false);
 assert.equal(await discordOriginMirrorUser(path,'other',item(),[]),false);
 assert.equal(await discordOriginMirrorUser(path,'target',item(null),[]),false);
}));
test('active ownership requires exact target/turn and Starting or Running state',()=>{
 for(const state of ['Pending','Starting','Running','Quarantined'] as const)assert.equal(discordActiveMirrorTurn('target',item(),[queueJob({state,turnId:'turn'})]),state==='Starting'||state==='Running');
 assert.equal(discordActiveMirrorTurn('target',item(null),[queueJob({state:'Running',turnId:'turn'})]),false);
 assert.equal(discordActiveMirrorTurn('other',item(),[queueJob({state:'Running',turnId:'turn'})]),false);
});
test('fresh snapshot blocks any Starting or goal-waiting job before item-specific suppression',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());
 await edit(path,"UPDATE codex_turn_queue SET state='starting'");
 await assert.rejects(currentDiscordMirrorOwner(path,'target',item('unrelated','agent_message')),MirrorOwnershipPendingError);
 await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn',goal_waiting=1");
 await assert.rejects(currentDiscordMirrorOwner(path,'target',item('unrelated','agent_message')),MirrorOwnershipPendingError);
 await edit(path,"UPDATE codex_turn_queue SET goal_waiting=0");
 assert.equal(await currentDiscordMirrorOwner(path,'target',item('unrelated','agent_message')),false);
 assert.equal(await currentDiscordMirrorOwner(path,'target',item('turn','agent_message')),true);
}));
test('observed running completion blocks goal transition gap before cursor may advance',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn'; INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES('target','turn',1,'{}')");
 await assert.rejects(currentDiscordMirrorOwner(path,'target',item('new-goal','agent_message')),MirrorOwnershipPendingError);
 await edit(path,"DELETE FROM codex_observed_completions");
 assert.equal(await currentDiscordMirrorOwner(path,'target',item('new-goal','agent_message')),false);
}));
test('fresh query does not reuse stale pending snapshot or let unrelated thread hold another',async()=>storeFixture(async path=>{
 await enqueue(path,queueJob());assert.equal(await currentDiscordMirrorOwner(path,'target',item()),false);
 await edit(path,"UPDATE codex_turn_queue SET state='running',turn_id='turn'");
 assert.equal(await currentDiscordMirrorOwner(path,'target',item()),true);
 assert.equal(await currentDiscordMirrorOwner(path,'foreign',item()),false);
}));
test('input accessors and proxy queue arrays cannot execute callbacks',async()=>storeFixture(async path=>{
 let calls=0;const jobs=new Proxy([],{get(){calls++;throw Error('trap');}});
 assert.throws(()=>discordActiveMirrorTurn('target',item(),jobs),TypeError);
 await assert.rejects(discordOriginMirrorUser(path,'target',{...item(),get text(){calls++;return 'x';}},[]),TypeError);
 const entries:ReturnType<typeof queueJob>[]=[];Object.defineProperty(entries,'0',{get(){calls++;return queueJob();}});
 assert.throws(()=>discordActiveMirrorTurn('target',item(),entries),TypeError);assert.equal(calls,0);
}));
