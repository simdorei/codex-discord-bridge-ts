import {storeFixture} from "../../helpers/store-fixture.ts";
import {StateAccessFacade as state} from "../../../src/store/state-access-facade.ts";
import {openInitialized} from "../../../src/store/owned-driver.ts";
import assert from "node:assert/strict";
import {test} from "node:test";
import {queueJob} from "../../helpers/queue-job.ts";
import {TerminalFence} from "../../../src/runtime/completion/terminal-fence.ts";
import {sendTyping,TypingDeliveryError,type TypingBackend,type TypingLifecycleSubscription,type TypingTransport} from "../../../src/runtime/completion/typing.ts";
function backend(){let generation=1n,version=0;const signals=new Set<()=>void>();let subscriptions=0;const value:TypingBackend={generation:()=>generation,async lifecycleSnapshot(){return {healthy:true,quarantined:false,restartPending:false};},async activeTurnId(){return "turn";},subscribeLifecycle(){const initial=version;subscriptions++;let disposed=false;return {hasChanged:()=>initial!==version,changed(signal?:AbortSignal){if(initial!==version)return Promise.resolve();return new Promise<void>((resolve,reject)=>{const done=()=>{signals.delete(done);signal?.removeEventListener("abort",abort);resolve();};const abort=()=>{signals.delete(done);reject(signal?.reason);};signals.add(done);signal?.addEventListener("abort",abort,{once:true});});},dispose(){if(!disposed){disposed=true;subscriptions--;}}} as TypingLifecycleSubscription;}};return {value,revoke(){version++;for(const wake of [...signals])wake();},replace(){generation++;},subscriptions:()=>subscriptions,waiters:()=>signals.size};}
const job=(id:string,channel=1n)=>queueJob({jobId:id,targetThreadId:id,channelId:channel,state:"Running",turnId:"turn"});
function store(jobs:ReturnType<typeof queueJob>[]){return {async listFiltered(){return jobs;},async pendingObservedCompletions(){return [] as {threadId:string;turnId:string;generation:bigint;payload:string}[];}};}
test("typing filters nonrunning, goal, observed terminal, wrong active turn and duplicate channel",async()=>{
  const b=backend(),f=new TerminalFence(),jobs=[{...job("pending"),state:"Pending" as const},{...job("goal"),goalWaiting:true},job("terminal"),job("wrong"),job("a"),job("same-channel"),job("b",2n)];
  b.value.activeTurnId=async t=>t==="wrong"?"other":"turn";const db=store(jobs);db.pendingObservedCompletions=async()=>[{threadId:"terminal",turnId:"turn",generation:99n,payload:"{}"}];const sent:bigint[]=[];
  await sendTyping("unused",b.value,f,{async createTyping(channel){sent.push(channel);}},db);assert.deepEqual(sent,[1n,2n]);assert.equal(f.pendingSubscribers,0);assert.equal(b.subscriptions(),0);assert.equal(b.waiters(),0);
});
test("unhealthy lifecycle avoids all database reads",async()=>{
  const b=backend();b.value.lifecycleSnapshot=async()=>({healthy:false,quarantined:false,restartPending:false});let reads=0;const db=store([]);db.listFiltered=async()=>{reads++;return [];};await sendTyping("unused",b.value,new TerminalFence(),{async createTyping(){throw new Error("no send");}},db);assert.equal(reads,0);assert.equal(b.subscriptions(),0);
});
test("terminal while disk read is pending survives retention and admits no typing",async()=>{
  const b=backend(),f=new TerminalFence(),db=store([job("a")]);db.listFiltered=async()=>{f.stop(1n,"a","turn");return [job("a")];};let sent=0;await sendTyping("unused",b.value,f,{async createTyping(){sent++;}},db);assert.equal(sent,0);assert.equal(f.stopped(1n,"a","turn"),true);
});
test("terminal revocation aborts and joins pending transport before returning",async()=>{
  const b=backend(),f=new TerminalFence();let started!:()=>void,finish!:()=>void,aborted=false,settled=false;const began=new Promise<void>(r=>started=r);
  const transport:TypingTransport={async createTyping(_channel,signal){started();await new Promise<void>(resolve=>{finish=()=>{settled=true;resolve();};signal.addEventListener("abort",()=>{aborted=true;},{once:true});});}};
  let returned=false;const work=sendTyping("unused",b.value,f,transport,store([job("a")])).then(()=>{returned=true;});await began;f.stop(1n,"a","turn");for(let i=0;i<8;i++)await Promise.resolve();assert.equal(aborted,true);assert.equal(returned,false);finish();await work;assert.equal(settled,true);assert.equal(f.pendingSubscribers,0);assert.equal(b.waiters(),0);
});
test("lifecycle revocation stops later channels and releases watchers",async()=>{
  const b=backend(),f=new TerminalFence();let started!:()=>void;const began=new Promise<void>(r=>started=r),sent:bigint[]=[];
  const work=sendTyping("unused",b.value,f,{async createTyping(channel,signal){sent.push(channel);started();await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));}},store([job("a"),job("b",2n)]));
  await began;b.revoke();await work;assert.deepEqual(sent,[1n]);assert.equal(f.pendingSubscribers,0);assert.equal(b.waiters(),0);
});
test("backend and HTTP errors preserve first error while later channels are attempted",async()=>{
  const b=backend(),f=new TerminalFence(),sent:bigint[]=[],first={backend:true};b.value.activeTurnId=async target=>{if(target==="a")throw first;return "turn";};
  await assert.rejects(sendTyping("unused",b.value,f,{async createTyping(channel){sent.push(channel);throw new Error("http");}},store([job("a"),job("b",2n)])),e=>e===first);assert.deepEqual(sent,[2n]);assert.equal(f.pendingSubscribers,0);
  await assert.rejects(sendTyping("unused",backend().value,new TerminalFence(),{async createTyping(){throw "opaque";}},store([job("a")])),e=>e instanceof TypingDeliveryError&&e.source==="opaque");
});
test("generation change during active lookup suppresses send",async()=>{
  const b=backend(),f=new TerminalFence();b.value.activeTurnId=async()=>{b.replace();return "turn";};let sent=0;await sendTyping("unused",b.value,f,{async createTyping(){sent++;}},store([job("a")]));assert.equal(sent,0);
});
test("default state facade uses real stored running owner and terminal journal filter",async()=>storeFixture(async path=>{
  await state.enqueue(path,queueJob());const claim=(await state.tryBeginAttempt(path,"saved",[],1n))!;await state.markRunningIfClaimed(path,claim,"turn");let sent=0;const transport:TypingTransport={async createTyping(){sent++;}};
  await sendTyping(path,backend().value,new TerminalFence(),transport);assert.equal(sent,1);
  const db=await openInitialized(path);try{db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload) VALUES ('target','turn',1,'{}')");}finally{db.close();}
  await sendTyping(path,backend().value,new TerminalFence(),transport);assert.equal(sent,1);
}));
test("unexpected post-dispatch watch inspection error still aborts and joins transport",async()=>{
  const b=backend(),f=new TerminalFence(),subscribe=b.value.subscribeLifecycle,unexpected={watchFailure:true};let checks=0;
  b.value.subscribeLifecycle=()=>{const receiver=subscribe();return {...receiver,hasChanged(){if(++checks===2)throw unexpected;return receiver.hasChanged();}};};
  let started!:()=>void,finish!:()=>void,aborted=false,returned=false;const began=new Promise<void>(r=>started=r);
  const result=sendTyping("unused",b.value,f,{async createTyping(_channel,signal){started();await new Promise<void>(r=>{finish=r;signal.addEventListener("abort",()=>{aborted=true;},{once:true});});}},store([job("a")])).then(()=>({error:null}),error=>({error})).then(value=>{returned=true;return value;});
  await began;f.stop(1n,"a","turn");for(let i=0;i<12;i++)await Promise.resolve();
  try{assert.equal(aborted,true);assert.equal(returned,false);}finally{finish();await result;}
  assert.strictEqual((await result).error,unexpected);assert.equal(f.pendingSubscribers,0);assert.equal(b.waiters(),0);
});
