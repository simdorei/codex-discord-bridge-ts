import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {GenerationWatch} from '../../../src/app-server/generation-watch.ts';
import {CompletionTypingDriver,residentTypingBackend} from '../../../src/runtime/completion/typing-driver.ts';
import {sendTyping} from '../../../src/runtime/completion/typing.ts';
import {TerminalFence} from '../../../src/runtime/completion/terminal-fence.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {queueJob} from '../../helpers/queue-job.ts';
import type {TickSource} from '../../../src/runtime/delayed-ticks.ts';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
function backend(){const watch=new GenerationWatch(1n),server={generation:()=>1n,subscribeLifecycleChanges:()=>watch.subscribe(),lifecycleSnapshot:()=>({generation:1n,healthy:true,quarantined:false,restartPending:false,processId:123}),activeTurnId:()=> 'turn'};return {watch,server,value:residentTypingBackend(server)};}
async function seed(path:string){await state.enqueue(path,queueJob());const c=(await state.tryBeginAttempt(path,'saved',[],1n))!;await state.markRunningIfClaimed(path,c,'turn');}
class ManualTicks implements TickSource{closed=false;resolve:(()=>void)|null=null;wait():Promise<void>{assert.equal(this.resolve,null);return new Promise(r=>{this.resolve=r;});}fire(){const r=this.resolve;this.resolve=null;r?.();}close(){this.closed=true;this.fire();}}
test('native watch adapter latches equal-generation publication after waiter consumption',async()=>{
 const b=backend(),subscription=b.value.subscribeLifecycle();assert.equal(subscription.hasChanged(),false);const waiting=subscription.changed();b.watch.replace(1n);assert.equal(subscription.hasChanged(),true);await waiting;assert.equal(subscription.hasChanged(),true);subscription.dispose();assert.equal(b.watch.receiverCount,0);const closed=b.value.subscribeLifecycle();b.watch.close();assert.equal(closed.hasChanged(),true);closed.dispose();
});
test('cancelled watch wait does not falsely revoke the next typing channel',async()=>{
 const b=backend(),sub=b.value.subscribeLifecycle(),abort=new AbortController(),reason=new Error('wait done');const pending=sub.changed(abort.signal),rejected=assert.rejects(pending,e=>e===reason);abort.abort(reason);await rejected;assert.equal(sub.hasChanged(),false);sub.dispose();assert.equal(b.watch.pendingWaiters,0);
});
test('external cancellation aborts and joins typing transport, preserving original stop reason',{timeout:5000},async()=>storeFixture(async path=>{
 await seed(path);const b=backend(),fence=new TerminalFence(),abort=new AbortController(),entered=deferred(),release=deferred(),reason=new Error('stop');let requestSignal:AbortSignal|undefined,finished=false;
 const pending=sendTyping(path,b.value,fence,{createTyping:async(_channel,signal)=>{requestSignal=signal;entered.resolve();await release.promise;}},state,abort.signal);const rejected=assert.rejects(pending,e=>e===reason).then(()=>{finished=true;});await entered.promise;abort.abort(reason);await tick();assert.equal(requestSignal?.aborted,true);assert.equal(requestSignal?.reason,reason);assert.equal(finished,false);release.resolve();await rejected;assert.equal(b.watch.receiverCount,0);assert.equal(b.watch.pendingWaiters,0);assert.equal(fence.pendingSubscribers,0);
}));
test('driver is single-flight and shutdown closes ticks and subscriptions',{timeout:5000},async()=>storeFixture(async path=>{
 await seed(path);const b=backend(),fence=new TerminalFence(),abort=new AbortController(),entered=deferred(),ticks=new ManualTicks(),errors:unknown[]=[];let calls=0;
 const driver=new CompletionTypingDriver(path,b.value,fence,{createTyping:async(_c,signal)=>{calls++;entered.resolve();await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true});});}},e=>{errors.push(e);});
 const running=driver.run(abort.signal,ticks);await entered.promise;for(let i=0;i<3;i++){ticks.fire();await tick();}assert.equal(calls,1);abort.abort();await running;assert.equal(ticks.closed,true);assert.deepEqual(errors,[]);assert.equal(b.watch.receiverCount,0);assert.equal(fence.pendingSubscribers,0);await assert.rejects(driver.run(abort.signal),/already used/);
}));
test('terminal arrival during a typing request cancels it while the independent completion path advances',{timeout:5000},async()=>storeFixture(async path=>{
 await seed(path);const b=backend(),fence=new TerminalFence(),entered=deferred(),abort=new AbortController(),ticks=new ManualTicks();let aborted=false;
 const driver=new CompletionTypingDriver(path,b.value,fence,{createTyping:async(_c,signal)=>{entered.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true}));}},()=>{});const running=driver.run(abort.signal,ticks);await entered.promise;fence.stop(1n,'target','turn');await tick();await tick();assert.equal(aborted,true);assert.equal(b.watch.pendingWaiters,0);abort.abort();await running;
}));
test('pre-aborted typing driver performs no store or transport operation',async()=>{
 const b=backend(),abort=new AbortController();abort.abort();const ticks=new ManualTicks();await new CompletionTypingDriver('/missing/never-create.sqlite',b.value,new TerminalFence(),{createTyping:async()=>{throw new Error('No send');}},()=>{}).run(abort.signal,ticks);assert.equal(ticks.closed,true);assert.equal(b.watch.receiverCount,0);
});
