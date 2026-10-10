import {it} from 'node:test';import assert from 'node:assert/strict';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {claimProcessedMessageGuarded} from '../../src/store/processed-claim-guard.ts';import {MessageGapTracker} from '../../src/discord/gateway/message-gaps.ts';
it('current original gap fence permits one durable unique marker and duplicate returns false',async()=>storeFixture(async path=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fence=rx.captureClearFence(1n)!;try{assert.equal(await claimProcessedMessageGuarded(path,3n,1,operation=>rx.withCurrentFence(fence,operation)),true);assert.equal(await claimProcessedMessageGuarded(path,3n,2,operation=>rx.withCurrentFence(fence,operation)),false);assert.equal(await state.isProcessedMessage(path,3n),true);}finally{rx.dispose();tracker.close();}
}));
it('gap advanced before guarded mutation leaves no processed marker',async()=>storeFixture(async path=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fence=rx.captureClearFence(1n)!;try{tracker.record(1n,{timestampMicros:1n,messageId:3n},'Full');await assert.rejects(claimProcessedMessageGuarded(path,3n,1,operation=>rx.withCurrentFence(fence,operation)),/advanced/);assert.equal(await state.isProcessedMessage(path,3n),false);assert.equal(rx.snapshot().length,1);}finally{rx.dispose();tracker.close();}
}));
it('ordinary SQLite constraint failure rolls back without poisoning a valid gap tracker',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec("CREATE TRIGGER fail_processed BEFORE INSERT ON discord_processed_messages BEGIN SELECT RAISE(ABORT,'fixture SQL failure');END");}finally{db.close();}
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fence=rx.captureClearFence(1n)!;try{await assert.rejects(claimProcessedMessageGuarded(path,3n,1,operation=>rx.withCurrentFence(fence,operation)),/fixture SQL failure/);assert.equal(rx.snapshot().length,0);assert.notEqual(rx.captureClearFence(1n),null);assert.equal(await state.isProcessedMessage(path,3n),false);}finally{rx.dispose();tracker.close();}
}));
it('missing, repeated, asynchronous or nonvoid guard cannot commit and leaked operation expires',async()=>storeFixture(async path=>{
 let leaked:(()=>void)|undefined;
 await assert.rejects(claimProcessedMessageGuarded(path,3n,1,operation=>{leaked=operation;}),/did not invoke/);assert.throws(()=>leaked!(),/expired/);
 await assert.rejects(claimProcessedMessageGuarded(path,3n,1,operation=>{operation();operation();}),/already consumed/);
 await assert.rejects(claimProcessedMessageGuarded(path,3n,1,((operation:()=>void)=>{operation();return 1;}) as never),/return void/);
 await assert.rejects(claimProcessedMessageGuarded(path,3n,1,operation=>{operation();try{operation();}catch{}}),/more than once/);
 await assert.rejects(claimProcessedMessageGuarded(path,3n,1,async operation=>{operation();}),/synchronous/);
 assert.equal(await state.isProcessedMessage(path,3n),false);
}));
it('guard exception after INSERT rolls back rather than reporting a durable claim',async()=>storeFixture(async path=>{
 const error=new Error('guard failed');await assert.rejects(claimProcessedMessageGuarded(path,3n,1,operation=>{operation();throw error;}),e=>e===error);assert.equal(await state.isProcessedMessage(path,3n),false);
}));
