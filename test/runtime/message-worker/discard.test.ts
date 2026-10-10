import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {classifyGatewayMessage} from '../../../src/runtime/message-worker/classification.ts';
import {admitMessageCandidateAt,MessageDatabaseMismatchError} from '../../../src/runtime/message-worker/admission.ts';
import {discardMessageCandidateAt as discard} from '../../../src/runtime/message-worker/discard.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import * as processed from '../../../src/store/processed-messages.ts';
const config={enableMessageContent:true,plainAskMentionUserIds:new Set<bigint>()},policy=new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]});
async function candidate(path:string,id:number,text:string){const message=decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content:text,edited_timestamp:null,embeds:[],id:String(id),mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0}));const c=await classifyGatewayMessage(message,path,config,policy,null);if(c.kind!=='Candidate')throw Error('fixture');return c.candidate;}
const options={now:()=>101,report:()=>{}};
test('historical discard writes only dedup marker and does not arm new or create executable custody',()=>storeFixture(async path=>{
 assert.equal(await discard(await candidate(path,3,'!new'),100),true);assert.equal(await state.isProcessedMessage(path,3n),true);assert.equal(await state.getIngress(path,'message:3'),null);assert.equal(await state.pendingNewPrompt(path,1n,2n,4n),null);
 assert.equal(await discard(await candidate(path,3,'!new'),200),false);assert.equal(await admitMessageCandidateAt(await candidate(path,3,'!new'),300,options),null);
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT seen_at FROM discord_processed_messages WHERE message_id=3').get()!.seen_at,100);}finally{db.close();}
}));
test('historical plain message never consumes an existing first-prompt reservation',()=>storeFixture(async path=>{
 const a=(await admitMessageCandidateAt(await candidate(path,3,'!new'),100,options))!;await a.dispose();assert.equal(await discard(await candidate(path,4,'historical'),101),true);assert.equal(await state.pendingNewPrompt(path,1n,2n,5n),'message:3');assert.equal(await state.getIngress(path,'message:4'),null);
 const live=(await admitMessageCandidateAt(await candidate(path,5,'live'),102,options))!,p=live.intoProcessingParts(path);try{assert.deepEqual(p.frozenPlan,{ok:true,value:{Execute:{New:{prompt:'live'}}}});}finally{await p.custody.dispose();}
}));
test('shared unique processed row fences simultaneous discard and executable admission',()=>storeFixture(async path=>{
 const c1=await candidate(path,7,'hello'),c2=await candidate(path,7,'hello');const [discarded,admitted]=await Promise.all([discard(c1,100),admitMessageCandidateAt(c2,100,options)]);
 assert.equal(Number(discarded)+Number(admitted!==null),1);assert.equal(await state.isProcessedMessage(path,7n),true);if(admitted)await admitted.dispose();else assert.equal(await state.getIngress(path,'message:7'),null);
}));
test('discard rejects invalid time after consuming candidate and rejects forged instances',()=>storeFixture(async path=>{
 for(const [i,time] of [-1,NaN,Infinity].entries()){const c=await candidate(path,10+i,'hello');await assert.rejects(discard(c,time),TypeError);assert.throws(()=>c.intoAdmissionParts(),/consumed/);assert.equal(await state.isProcessedMessage(path,BigInt(10+i)),false);}
 let hooks=0;await assert.rejects(discard({intoAdmissionParts(){hooks++;}} as any,100),TypeError);assert.equal(hooks,0);
}));
test('native marker errors remain errors, never mistaken for a duplicate',()=>storeFixture(async path=>{
 const c=await candidate(path,15,'hello'),db=await openInitialized(path);try{db.exec("CREATE TRIGGER deny_marker BEFORE INSERT ON discord_processed_messages BEGIN SELECT RAISE(ABORT,'fixture denied marker'); END");}finally{db.close();}
 await assert.rejects(discard(c,100),/fixture denied marker/);assert.equal(await state.isProcessedMessage(path,15n),false);assert.equal(await state.getIngress(path,'message:15'),null);
}));
test('processed source facade aliases preserve i64 bits and mark overwrite vs claim retain semantics',()=>storeFixture(async path=>{
 assert.equal(state.claimProcessedMessage,processed.claimProcessedMessage);assert.equal(state.isProcessedMessage,processed.isProcessedMessage);assert.equal(state.markProcessedMessage,processed.markProcessedMessage);
 for(const id of [-(1n<<63n),(1n<<63n)-1n]){assert.equal(await state.claimProcessedMessage(path,id,1.25),true);assert.equal(await state.claimProcessedMessage(path,id,2.5),false);await state.markProcessedMessage(path,id,3.75);assert.equal(await state.isProcessedMessage(path,id),true);}
 const db=await openInitialized(path);try{assert.deepEqual(db.prepare('SELECT seen_at FROM discord_processed_messages ORDER BY message_id').all().map(r=>r.seen_at),[3.75,3.75]);}finally{db.close();}
 for(const id of [1n<<63n,-(1n<<63n)-1n])await assert.rejects(state.claimProcessedMessage(path,id,1),TypeError);
}));
test('database mismatch diagnostic uses source Rust debug escaping for controls',()=>{
 const error=new MessageDatabaseMismatchError('a\0b','c\x1fd');assert.equal(error.message,'admitted Discord message database mismatch: claimed="a\\0b" context="c\\u{1f}d"');
});
