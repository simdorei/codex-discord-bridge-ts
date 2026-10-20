import assert from 'node:assert/strict';
import {parentPort,workerData,MessagePort} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {receiveSequentialMutationClient,BusyBeforePost,InvalidInputBeforePost,ClosedBeforePost,SequenceExhaustedBeforePost,BrokerOutcomeUnknown} from '../../../src/runtime/sequential-mutation-broker-client.ts';
import {ResidentLocalMutationOwner} from '../../../src/runtime/resident-local-mutation-owner.ts';
const originalParent=parentPort;if(originalParent===null)throw Error('Requester requires original parent');
const parent=originalParent;
const scenario:string=workerData.scenario,gate=new Int32Array(workerData.gate);
const report=(event:string,value:unknown=true)=>parent.postMessage({event,value});
async function waitGate(n:number){const deadline=Date.now()+10000;while(Atomics.load(gate,0)<n){if(Date.now()>=deadline)throw Error('Frozen requester event deadline');await delay(2);}}
async function run(){
 const originalOn=MessagePort.prototype.on;let dropped=false;
 if(scenario.startsWith('lost-'))MessagePort.prototype.on=function(event:string,listener:(...args:any[])=>void){
  if(event==='message')return originalOn.call(this,event,(value:any)=>{
   const b=value?.version===2?value.body:null;
   const match=scenario==='lost-begin'?b?.kind==='accepted'&&b.phase==='begin':scenario==='lost-begin-ack'?b?.kind==='begin-acknowledged':scenario==='lost-finish'?b?.kind==='accepted'&&b.phase==='finish':b?.kind==='retired';
   if(match&&!dropped){dropped=true;report('suppressed',b.kind);return;}listener(value);
  });return originalOn.call(this,event,listener);
 };
 const client=await receiveSequentialMutationClient();MessagePort.prototype.on=originalOn;report('ready');await waitGate(1);
 const first=workerData.ordinary[0];
 if(scenario==='nonzero-close'){await client.closeIdle();process.exitCode=1;report('quarantined');return;}
 if(scenario==='headroom'){
  assert.throws(()=>client.beginOrdinary(first),SequenceExhaustedBeforePost);assert.equal(client.snapshot().operationId,null);report('exhausted');await client.closeIdle();report('closed');return;
 }
 if(scenario==='invalid-local'){
  const before=client.snapshot();let reads=0;
  assert.throws(()=>client.beginOrdinary({...first,params:Object.defineProperty({},'unsafe',{enumerable:true,get(){reads++;return 'bad';}})}),InvalidInputBeforePost);
  assert.equal(reads,0);assert.deepEqual(client.snapshot(),before);
 }
 if(scenario==='receipts'||scenario==='row-changed'){
  const owner=new ResidentLocalMutationOwner(workerData.path,'runtime',()=> 'safe',client),other=new ResidentLocalMutationOwner(workerData.path,'runtime',()=> 'safe',client);
  const receipt=await owner.beginMutationWithOrigin(first);assert.ok(receipt);owner.validate(receipt);
  assert.throws(()=>other.validate(receipt));assert.throws(()=>owner.validate(structuredClone(receipt)));report('prepared-1');await waitGate(2);
  if(scenario==='row-changed'){assert.throws(()=>owner.validate(receipt));owner.markOutcomeUnknown(receipt);assert.throws(()=>owner.validate(receipt));report('quarantined');return;}
  const pending=owner.finishMutation(receipt,'reply_ok');assert.throws(()=>owner.validate(receipt));assert.throws(()=>owner.finishMutation(receipt,'reply_ok'));await pending;report('retired-1');await waitGate(3);await owner.close();report('closed');return;
 }
 if(scenario==='normal'||scenario==='busy'||scenario==='invalid-local'||scenario==='finite'||scenario==='drain'){
  const operations=scenario==='normal'?[['ordinary',first],['queue',workerData.queue],['stop',workerData.stop],...workerData.ordinary.slice(1).map((c:unknown)=>['ordinary',c])]:scenario==='finite'?workerData.ordinary.slice(0,2).map((c:unknown)=>['ordinary',c]):[['ordinary',first]];
  let id=0;
  for(const [kind,claim] of operations){
   const pending=kind==='queue'?client.beginQueue(claim):kind==='stop'?client.beginStop(claim):client.beginOrdinary(claim);
   if(scenario==='busy'){
    const before=client.snapshot();let failure:unknown;
    assert.throws(()=>client.beginOrdinary(workerData.ordinary[1]),error=>{failure=error;return error instanceof BusyBeforePost;});
    assert.equal(client.ownsUnsubmittedFailure(failure,workerData.ordinary[1].attemptId,workerData.ordinary[1].wire,workerData.ordinary[1].method),true);
    assert.equal(client.ownsUnsubmittedFailure(new BusyBeforePost(),workerData.ordinary[1].attemptId,workerData.ordinary[1].wire,workerData.ordinary[1].method),false);
    assert.deepEqual(client.snapshot(),before);
   }
   const handle=await pending;id++;assert.equal(handle.operationId,id);assert.ok(Object.isFrozen(handle));
   assert.throws(()=>client.finish({...handle},'reply_ok'));report(`prepared-${id}`);await waitGate(2*id);
   const finish=client.finish(handle,'reply_ok');assert.throws(()=>client.finish(handle,'reply_ok'));await finish;
   assert.equal(client.snapshot().retiredThrough,id);assert.equal(client.snapshot().operationId,null);report(`retired-${id}`);await waitGate(2*id+1);
  }
  if(scenario==='drain'){assert.throws(()=>client.beginOrdinary(workerData.ordinary[1]),ClosedBeforePost);}
  if(scenario==='finite'){assert.throws(()=>client.beginOrdinary(workerData.ordinary[2]),error=>error instanceof ClosedBeforePost||error instanceof SequenceExhaustedBeforePost);assert.equal(client.snapshot().retiredThrough,2);report('exhausted');}
  await client.stopNewWork();await client.closeIdle();report('closed');return;
 }
 try{
  const handle=await client.beginOrdinary(first);
  if(scenario==='unknown'||scenario==='hold-requester'){
   client.quarantine(handle);assert.equal(client.snapshot().state,'quarantined');assert.throws(()=>client.beginOrdinary(workerData.ordinary[1]),ClosedBeforePost);
   if(scenario==='hold-requester'){report('holding');await waitGate(2);}report('quarantined');return;
  }
  if(scenario==='sql-finish-failure'){report('prepared');await waitGate(2);}
  await client.finish(handle,'reply_ok');throw Error('Negative scenario unexpectedly succeeded');
 }catch(error){
  assert.ok(error instanceof BrokerOutcomeUnknown);assert.equal(client.snapshot().state,'quarantined');assert.throws(()=>client.beginOrdinary(workerData.ordinary[1]),ClosedBeforePost);
  if(scenario==='lost-terminal-ack')assert.equal(client.snapshot().knownFinishOperationId,1,'confirmed persistence remains diagnostic truth despite lost retirement ACK');
  report('quarantined');
 }
}
async function rawRun(){
 const bootstrap:any=await new Promise(resolve=>parent.once('message',resolve));const endpoint:MessagePort=bootstrap.port;let exchange=0;
 const call=(body:unknown):Promise<any>=>new Promise((resolve,reject)=>{
  const closed=()=>reject(Error('Endpoint closed'));const message=(value:any)=>{endpoint.off('close',closed);resolve(value.body);};
  endpoint.once('close',closed);endpoint.once('message',message);endpoint.postMessage({version:2,epoch:bootstrap.epoch,exchange:++exchange,body});
 });
 async function observe(){const deadline=Date.now()+10000;for(;;){if(Date.now()>=deadline)throw Error('Frozen raw observation deadline');await delay(bootstrap.limits.minStatusIntervalMs);const r=await call({kind:'status',operationId:1});if(r.kind!=='pending'&&r.kind!=='rejected')return r;}}
 report('ready',await call({kind:'ready'}));await waitGate(1);
 let body:unknown={kind:'begin',operationId:1,operation:'ordinary',claim:workerData.ordinary[0]};let epoch=bootstrap.epoch;
 if(scenario==='raw-old-epoch')epoch=epoch==='0'.repeat(32)?'1'.repeat(32):'0'.repeat(32);
 if(scenario==='raw-exchange')exchange++;
 if(scenario==='raw-future-id')body={...(body as object),operationId:2};
 if(scenario==='raw-kind')body={...(body as object),operation:'arbitrary-sql'};
 if(scenario==='raw-extra-field')body={...(body as object),path:'caller-path'};
 if(scenario==='raw-duplicate-ready')body={kind:'ready'};
 if(scenario==='raw-early-finish')body={kind:'finish',operationId:1,outcome:'reply_ok'};
 if(scenario==='raw-prepared-expiry'){
  const closed=new Promise<void>(resolve=>endpoint.once('close',()=>resolve()));await call(body);assert.equal((await observe()).kind,'begin-confirmed');await call({kind:'ack-begin',operationId:1});report('prepared');endpoint.ref();await closed;report('quarantined');return;
 }
 if(scenario==='raw-duplicate-begin'||scenario==='raw-retired-id'){
  await call(body);
  if(scenario==='raw-retired-id'){
   assert.equal((await observe()).kind,'begin-confirmed');await call({kind:'ack-begin',operationId:1});await call({kind:'finish',operationId:1,outcome:'reply_ok'});assert.equal((await observe()).result,'finish-confirmed');assert.equal((await call({kind:'ack-terminal',operationId:1})).retiredThrough,1);
  }
 }
 const closed=new Promise<void>(resolve=>endpoint.once('close',()=>resolve()));endpoint.postMessage({version:2,epoch,exchange:++exchange,body});endpoint.ref();await closed;report('quarantined');
}
void (scenario.startsWith('raw-')?rawRun():run()).catch(error=>report('error',{name:error instanceof Error?error.name:'error',message:error instanceof Error?error.message:String(error),stack:error instanceof Error?error.stack:undefined})).finally(()=>parent.close());
