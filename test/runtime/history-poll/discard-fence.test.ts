import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {classifyGatewayMessage} from '../../../src/runtime/message-worker/classification.ts';
import {admitMessageCandidateAt,MessageDatabaseMismatchError} from '../../../src/runtime/message-worker/admission.ts';
import {DiscordHistoryDiscardFence} from '../../../src/runtime/history-poll/discard-fence.ts';
import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import * as processed from '../../../src/store/processed-messages.ts';
const config={enableMessageContent:true,plainAskMentionUserIds:new Set<bigint>()},policy=new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]});
const decoded=(id:number|string,text:string)=>decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content:text,edited_timestamp:null,embeds:[],id:String(id),mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0}));
async function candidate(path:string,id:number|string,text:string){const c=await classifyGatewayMessage(decoded(id,text),path,config,policy,null);if(c.kind!=='Candidate')throw Error('fixture');return c.candidate;}
test('captured current revision writes only processed marker, preserving new-prompt custody',()=>storeFixture(async path=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fence=DiscordHistoryDiscardFence.capture(rx,1n)!;
 try{assert.equal(await fence.claim(await candidate(path,3,'!new'),100),true);assert.equal(await fence.claim(await candidate(path,3,'!new'),200),false);assert.equal(await state.getIngress(path,'message:3'),null);assert.equal(await state.pendingNewPrompt(path,1n,2n,4n),null);assert.equal(await state.isProcessedMessage(path,3n),true);}finally{rx.dispose();tracker.close();}
}));
test('gap advancing while the owned database opens forbids discard and preserves recovery notice',()=>storeFixture(async path=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fence=DiscordHistoryDiscardFence.capture(rx,1n)!,c=await candidate(path,3,'hello');
 try{const pending=fence.claim(c,100);tracker.record(1n,{timestampMicros:1n,messageId:3n},'Full');await assert.rejects(pending,/advanced/);assert.equal(await state.isProcessedMessage(path,3n),false);assert.equal(rx.snapshot().length,1);assert.equal(DiscordHistoryDiscardFence.capture(rx,1n),null);}finally{rx.dispose();tracker.close();}
}));
test('cancellation while the database opens rolls back without poisoning tracker',()=>storeFixture(async path=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fence=DiscordHistoryDiscardFence.capture(rx,1n)!,c=await candidate(path,3,'hello'),controller=new AbortController(),reason=new Error('cancelled');
 try{const pending=fence.claim(c,100,controller.signal);controller.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(await state.isProcessedMessage(path,3n),false);assert.notEqual(rx.captureClearFence(1n),null);}finally{rx.dispose();tracker.close();}
}));
test('captured channel cannot authorize a different-channel candidate',()=>storeFixture(async path=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fence=DiscordHistoryDiscardFence.capture(rx,2n)!;
 try{await assert.rejects(fence.claim(await candidate(path,3,'hello'),100),/channel mismatch/);assert.equal(await state.isProcessedMessage(path,3n),false);}finally{rx.dispose();tracker.close();}
}));
test('native SQL failure preserves error and leaves current tracker usable',()=>storeFixture(async path=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fence=DiscordHistoryDiscardFence.capture(rx,1n)!,c=await candidate(path,3,'hello'),db=await openInitialized(path);try{db.exec("CREATE TRIGGER deny_processed BEFORE INSERT ON discord_processed_messages BEGIN SELECT RAISE(ABORT,'denied discard');END");}finally{db.close();}
 try{await assert.rejects(fence.claim(c,100),/denied discard/);assert.equal(await state.isProcessedMessage(path,3n),false);assert.notEqual(rx.captureClearFence(1n),null);}finally{rx.dispose();tracker.close();}
}));
test('closed receiver and invalid timestamp cannot write a marker',()=>storeFixture(async path=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fence=DiscordHistoryDiscardFence.capture(rx,1n)!;
 try{await assert.rejects(fence.claim(await candidate(path,3,'hello'),Infinity),/finite/);rx.dispose();await assert.rejects(fence.claim(await candidate(path,4,'hello'),100),/disposed/);assert.equal(await state.isProcessedMessage(path,3n),false);assert.equal(await state.isProcessedMessage(path,4n),false);}finally{rx.dispose();tracker.close();}
}));

import {GatewayIngress} from '../../../src/discord/gateway/ingress.ts';
import {isAcceptedGatewayMessageDeferral} from '../../../src/discord/gateway/message-custody.ts';
for(const timing of ['before-claim','opening','final-insert'] as const)test(`accepted original at ${timing} vetoes final processed INSERT without poisoning the gap fence`,t=>storeFixture(async path=>{
 const owner=new GatewayIngress(),rx=owner.subscribeMessageGaps(),view=owner.acceptedMessageView(),fence=DiscordHistoryDiscardFence.capture(rx,1n,view)!,id='9007199254740993',original=decoded(id,'!help'),c=await candidate(path,id,'!help');
 const publish=()=>assert.equal(owner.publish({kind:'Message',event:original},1).kind,'MessageAccepted');
 try{if(timing==='before-claim')publish();if(timing==='final-insert'){const claim=state.claimProcessedMessageGuarded;t.mock.method(state,'claimProcessedMessageGuarded',(path:string,id:bigint,time:number,guard:(operation:()=>void)=>void)=>claim(path,id,time,operation=>{publish();guard(operation);}));}
  const pending=fence.claim(c,100);if(timing==='opening')publish();await assert.rejects(pending,isAcceptedGatewayMessageDeferral);assert.equal(await state.isProcessedMessage(path,BigInt(id)),false);assert.equal(await state.getIngress(path,'message:'+id),null);assert.deepEqual(rx.snapshot(),[]);assert.notEqual(rx.captureClearFence(1n),null);assert.equal(view.size,1);
  t.mock.restoreAll();owner.receivers.messages.dispose();assert.equal(await fence.claim(await candidate(path,id,'!help'),101),true);assert.equal(await state.isProcessedMessage(path,BigInt(id)),true);assert.notEqual(rx.captureClearFence(1n),null);
 }finally{t.mock.restoreAll();for(const lane of Object.values(owner.receivers))lane.dispose();rx.dispose();owner.close();}
}));
test('discard fence captures exact view owner and only matching message/channel identity vetoes',()=>storeFixture(async path=>{
 const owner=new GatewayIngress(),other=new GatewayIngress(),rx=owner.subscribeMessageGaps(),fence=DiscordHistoryDiscardFence.capture(rx,1n,owner.acceptedMessageView())!;
 try{other.publish({kind:'Message',event:decoded(3,'!help')},1);assert.equal(await fence.claim(await candidate(path,3,'!help'),100),true);owner.publish({kind:'Message',event:decoded(4,'!help')},2);assert.equal(await fence.claim(await candidate(path,5,'!help'),100),true);await assert.rejects(fence.claim(await candidate(path,4,'!help'),100),isAcceptedGatewayMessageDeferral);assert.equal(await state.isProcessedMessage(path,4n),false);
 }finally{for(const o of [owner,other]){for(const lane of Object.values(o.receivers))lane.dispose();o.close();}rx.dispose();}
}));
