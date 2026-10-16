import {parentPort,workerData,MessagePort} from 'node:worker_threads';
import {setTimeout as delay} from 'node:timers/promises';
import {receiveNativeMutationClient} from '../../../src/runtime/native-mutation-broker-client.ts';
import type {MutationBrokerReplyBody} from '../../../src/runtime/native-mutation-broker-protocol.ts';
const port=parentPort;if(port===null)throw new Error('Fixture requires parent');
const parent=port;
const gate=new Int32Array(workerData.gate);
const report=(event:string,value:unknown)=>parent.postMessage({event,value});
async function waitGate(n:number){while(Atomics.load(gate,0)<n)await delay(2);}
async function run(){
 let dropped=false;
 const originalOn=MessagePort.prototype.on;
 if(workerData.scenario.startsWith('lost-')){
  MessagePort.prototype.on=function(event:string,listener:(...args:any[])=>void){
   if(event==='message')return originalOn.call(this,event,(value:any)=>{
    const body=value?.body;
    const match=workerData.scenario==='lost-begin-ack'?body?.kind==='acknowledged'&&body.phase==='begin':
     workerData.scenario==='lost-finish'?body?.kind==='accepted'&&body.phase==='finish':body?.kind==='acknowledged'&&body.phase==='terminal';
    if(match&&!dropped){dropped=true;report('suppressed',body.kind);return;}listener(value);
   });
   return originalOn.call(this,event,listener);
  };
 }
 const client=await receiveNativeMutationClient();MessagePort.prototype.on=originalOn;report('ready',true);
 await waitGate(1);
 const claim=workerData.claim;
 const submitted=client.begin(claim);
 if(workerData.scenario==='mutate'){claim.ownerId='changed';claim.attemptId='changed';claim.params.threadId='changed';}
 report('begin',await submitted);
 async function completed():Promise<MutationBrokerReplyBody>{
  for(;;){await delay(3);const result=await client.status();if(result.kind!=='pending'&&!(result.kind==='rejected'&&result.reason==='rate-limited'))return result;}
 }
 const result=await completed();report('begin-result',result);
 if(result.kind!=='begin-confirmed'){
  if(result.kind==='terminal')report('terminal-ack',await client.acknowledgeTerminal());
  else client.detach();return;
 }
 await waitGate(2);
 if(workerData.scenario==='detach-begin'){client.detach();report('detached',true);return;}
 if(workerData.scenario==='cancel'){report('closing',await client.cancel());return;}
 if(workerData.scenario==='close'||workerData.scenario==='hold-closed'){report('closing',await client.requestClose());if(workerData.scenario==='hold-closed'){report('holding-exit',true);await waitGate(4);}return;}
 if(workerData.scenario==='ttl'){
  await waitGate(3);try{await client.acknowledgeBegin();report('unexpected',true);}catch(e){report('closed-error',e instanceof Error?e.name:'error');}return;
 }
 report('begin-ack',await client.acknowledgeBegin());
 await waitGate(3);
 report('finish',await client.finish(result.beginSequence,'reply_ok'));
 const terminal=await completed();report('terminal',terminal);
 await waitGate(4);
 if(workerData.scenario==='detach-terminal'){client.detach();report('detached',true);return;}
 report('terminal-ack',await client.acknowledgeTerminal());
}
async function rawRun(){
 const bootstrap:any=await new Promise(resolve=>parent.once('message',resolve));
 const endpoint=bootstrap.port;let sequence=0;
 const exchange=(body:unknown):Promise<any>=>new Promise((resolve,reject)=>{
  const closed=()=>reject(new Error('OutcomeUnknown'));
  endpoint.once('close',closed);endpoint.once('message',(value:any)=>{endpoint.off('close',closed);resolve(value.body);});
  endpoint.postMessage({version:1,epoch:bootstrap.epoch,exchange:++sequence,body});
 });
 report('ready',await exchange({kind:'ready'}));await waitGate(1);
 if(workerData.scenario==='raw-foreign'){
  endpoint.postMessage({version:1,epoch:'f'.repeat(32),exchange:2,body:{kind:'begin',claim:workerData.claim}});
  await new Promise(resolve=>{endpoint.once('close',resolve);endpoint.ref();});report('closed',true);return;
 }
 report('begin',await exchange({kind:'begin',claim:workerData.claim}));
 report('duplicate-begin',await exchange({kind:'begin',claim:workerData.claim}));
 report('early-finish',await exchange({kind:'finish',beginSequence:2,outcome:'reply_ok'}));
 let result:any;do{await delay(3);result=await exchange({kind:'status'});}while(result.kind==='pending'||result.kind==='rejected'&&result.reason==='rate-limited');
 report('begin-result',result);await waitGate(2);
 if(workerData.scenario==='raw-injected'){
  endpoint.postMessage({version:1,epoch:bootstrap.epoch,exchange:++sequence,body:{kind:'finish',beginSequence:2,outcome:'reply_ok',ownerId:'foreign'}});
  await new Promise(resolve=>{endpoint.once('close',resolve);endpoint.ref();});report('closed',true);return;
 }
 report('repeat-result',await exchange({kind:'status'}));
 report('begin-ack',await exchange({kind:'ack-begin'}));await waitGate(3);
 report('finish',await exchange({kind:'finish',beginSequence:2,outcome:'reply_ok'}));
 report('duplicate-finish',await exchange({kind:'finish',beginSequence:2,outcome:'reply_error'}));
 do{await delay(3);result=await exchange({kind:'status'});}while(result.kind==='pending'||result.kind==='rejected'&&result.reason==='rate-limited');
 report('terminal',result);await waitGate(4);report('terminal-ack',await exchange({kind:'ack-terminal'}));endpoint.close();
}
void (workerData.scenario.startsWith('raw-')?rawRun():run()).catch(error=>{report(workerData.scenario.startsWith('lost-')?'loss-error':'error',{name:error instanceof Error?error.name:'error',message:error instanceof Error?error.message:'unknown'});}).finally(()=>parent.close());
