import {MessagePort,parentPort,workerData} from 'node:worker_threads';
import {receiveNativeCodecClient,type NativeCodecClient} from '../../../src/runtime/native-codec-broker-client.ts';
import {isBrokerEpoch,validateBrokerLimits,validateReplyEnvelope,type RequestStatus,type Submission} from '../../../src/runtime/native-codec-broker-protocol.ts';

/** Fixed trusted requester. All application instructions arrive in workerData.
 * Normal modes use only the client bootstrap. Fixed negative-wire modes consume
 * the same one initialization privately and send only their hardcoded violations.
 * Any parent input after bootstrap is invalid in every mode.
 * Reports travel outward on parentPort; no application control channel exists.
 * No native owner, worker slot, storage, dynamic import, or replacement port. */
type NegativeScenario='negative-epoch'|'negative-sequence'|'negative-surplus'|'negative-kind'|'negative-request-id'|'negative-ready'|'negative-stale'|'negative-counter'|'negative-duplicate'|'negative-duplicate-submit'|'negative-busy'|'negative-retirement-hole'|'negative-early-ack'|'negative-input';
type Scenario='round-trip'|'invalid-json'|'local-credit'|'cancel-close'|'detach'|'retain-terminal'|'idle'|'delayed-bootstrap'|'exchange-timeout'|NegativeScenario;
interface Script {readonly scenario:Scenario;readonly frames:readonly string[];readonly pauseMs:number;}
const checkedPort=parentPort;
if(checkedPort===null)throw new Error('FixtureRequiresWorker');
const port:MessagePort=checkedPort;
const script=workerData as Script;
const negatives:readonly NegativeScenario[]=['negative-epoch','negative-sequence','negative-surplus','negative-kind','negative-request-id','negative-ready','negative-stale','negative-counter','negative-duplicate','negative-duplicate-submit','negative-busy','negative-retirement-hole','negative-early-ack','negative-input'];
const scenarios:readonly Scenario[]=['round-trip','invalid-json','local-credit','cancel-close','detach','retain-terminal','idle','delayed-bootstrap','exchange-timeout',...negatives];
if(script===null||typeof script!=='object'||!scenarios.includes(script.scenario)||!Array.isArray(script.frames)||script.frames.length>2||script.frames.some(raw=>typeof raw!=='string'||raw.length>4096)||!Number.isSafeInteger(script.pauseMs)||script.pauseMs<0||script.pauseMs>2000)throw new Error('InvalidFixtureScript');
let client:NativeCodecClient|undefined,sequence=0,finished=false;let stopWire:(()=>void)|undefined;
const report=(kind:string,body:unknown=null):void=>{
 if(finished)return;
 if(++sequence>32)throw new Error('FixtureReportLimit');
 port.postMessage({sequence,kind,body});
};
const pause=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
const errorName=(error:unknown)=>error instanceof Error?error.name:'NonError';
const outcome=async(pending:Promise<unknown>):Promise<unknown>=>{
 try{return {ok:true,value:await pending};}catch(error){return {ok:false,error:errorName(error)};}
};
const deeplyFrozen=(value:unknown):boolean=>value===null||typeof value!=='object'||Object.isFrozen(value)&&Object.values(value).every(deeplyFrozen);
function accepted(value:Submission):number {
 if(!value.accepted)throw new Error('UnexpectedSubmissionRefusal');
 return value.requestId;
}
async function terminal(id:number,viaCancel=false):Promise<RequestStatus> {
 // At most one status exchange and one timer at any time. No poll queue.
 for(let attempt=0;attempt<800;attempt++){
  await pause(10);
  const status=await (viaCancel?client!.cancel(id):client!.status(id));
  if(status.state==='joined-result'||status.state==='joined-error')return status;
  if(status.state!=='pending')throw new Error('UnexpectedTerminalState');
 }
 throw new Error('FixtureTerminalDeadline');
}
// A bounded cleanup safeguard, not evidence that a native operation joined.
const watchdog=setTimeout(()=>{
 report('fixture-expired');finished=true;client?.detach();stopWire?.();port.close();process.exitCode=1;
},12000);
async function run():Promise<void> {
 if(negatives.includes(script.scenario as NegativeScenario)){await runNegative(script.scenario as NegativeScenario);return;}
 if(script.scenario==='delayed-bootstrap')await pause(script.pauseMs);
 client=await receiveNativeCodecClient();
 report('ready');
 const raw=script.frames[0]??'{"type":"hello_ack","protocol_version":10}';
 switch(script.scenario){
  case 'round-trip':case 'invalid-json':{
   for(const frame of script.frames){
    const submission=await client.submitGateway(frame),id=accepted(submission);
    const earlyAcknowledgement=await outcome(client.acknowledgeTerminal(id));
    const status=await terminal(id);
    const retainedSubmit=await outcome(client.submitGateway(frame));
    await pause(10);const delivered=await client.status(id);
    const lateCancel=await client.cancel(id);
    report('terminal',{submission,status,frozen:deeplyFrozen(status),earlyAcknowledgement,retainedSubmit,delivered,lateCancel});
    await client.acknowledgeTerminal(id);
    await pause(10);const retired=await client.status(id);
    const cancelledRetired=await client.cancel(id);
    report('retired',{requestId:id,retired,cancelledRetired});
   }
   report('close',await client.requestClose());break;
  }
  case 'local-credit':{
   let activeBehavior=0;
   const coercible={toString(){activeBehavior++;return raw;}};
   const invalidObject=await outcome(client.submitGateway(coercible as unknown as string));
   const invalidUtf8=await outcome(client.submitGateway('é'.repeat(2048)));
   const pending=client.submitGateway(raw);
   const concurrent=outcome(client.submitGateway(raw));
   const submission=await pending,id=accepted(submission);
   const firstStatus=client.status(id),concurrentStatus=outcome(client.status(id));
   const initialStatus=await firstStatus;
   const rateLimited=await outcome(client.status(id));
   report('credit',{activeBehavior,invalidObject,invalidUtf8,submission,concurrent:await concurrent,concurrentStatus:await concurrentStatus,rateLimited});
   const status=initialStatus.state==='joined-result'||initialStatus.state==='joined-error'?initialStatus:await terminal(id,true);report('terminal',{submission,status,frozen:deeplyFrozen(status)});
   await client.acknowledgeTerminal(id);
   const next=await client.submitGateway(raw);report('next',next);
   await terminal(accepted(next),true);await client.acknowledgeTerminal(accepted(next));
   report('close',await client.requestClose());break;
  }
  case 'cancel-close':{
   const submit=outcome(client.submitGateway(raw));
   const cancel=client.cancel(1),sameCancel=client.cancel(1),cancelled=outcome(cancel);
   const close=client.requestClose(),sameClose=client.requestClose();
   const blockedSubmit=outcome(client.submitGateway(raw));
   report('latches',{sameCancel:cancel===sameCancel,sameClose:close===sameClose,submit:await submit,cancel:await cancelled,close:await outcome(close),blockedSubmit:await blockedSubmit});break;
  }
  case 'detach':{
   const pending=outcome(client.submitGateway(raw));client.detach();client.detach();
   report('detached',{submission:await pending,next:await outcome(client.submitGateway(raw)),priorStatus:await outcome(client.status(1))});break;
  }
  case 'retain-terminal':{
   const submission=await client.submitGateway(raw),id=accepted(submission),status=await terminal(id);
   report('terminal',{submission,status,frozen:deeplyFrozen(status)});
   // Deliberately withhold ACK; endpoint TTL must close rather than reuse it.
   await pause(script.pauseMs);
   report('after-retention',{status:await outcome(client.status(id)),submit:await outcome(client.submitGateway(raw)),ack:await outcome(client.acknowledgeTerminal(id))});break;
  }
  case 'exchange-timeout':{
   report('ready-for-stall');await pause(25);
   const submission=await outcome(client.submitGateway(raw));
   report('timed-out',{submission,next:await outcome(client.submitGateway(raw)),priorStatus:await outcome(client.status(1))});break;
  }
  case 'idle':case 'delayed-bootstrap':{
   await pause(script.pauseMs);report('close',await outcome(client.requestClose()));break;
  }
 }
}
/** Review-only malformed sender, with no callback/payload injection or port API.
 * Every case has one ready exchange and at most three further hardcoded sends.
 * This does not pretend that a MAX_SAFE_INTEGER jump reaches real exhaustion. */
function runNegative(scenario:NegativeScenario):Promise<void> {
 return new Promise((resolve,reject)=>{
  let initialized=false,ended=false,privatePort:MessagePort|undefined,epoch='',sent=0;
  let maxResultUnits=0;
  const cleanup=():void=>{port.off('message',initialize);port.off('messageerror',badParent);};
  const finish=():void=>{if(ended)return;ended=true;cleanup();privatePort?.close();resolve();};
  const fail=():void=>{if(ended)return;ended=true;cleanup();privatePort?.close();reject(new Error('InvalidNegativeFixtureProtocol'));};
  const badParent=():void=>fail();
  stopWire=finish;
  const post=(value:unknown):void=>{if(++sent>4){fail();return;}privatePort!.postMessage(value);};
  const request=(exchangeId:number,kind:string,requestId:number|null,body:unknown=null)=>({v:1,epoch,exchangeId,kind,requestId,body});
  const submit=(exchangeId:number,requestId:number,raw='{"type":"hello_ack","protocol_version":10}')=>request(exchangeId,'submit',requestId,{operation:'remote.gateway.decode.v1',raw});
  const receive=(value:unknown):void=>{
   const reply=validateReplyEnvelope(value,epoch,maxResultUnits);if(reply===null){fail();return;}
   report('wire-response',reply);
   if(reply.kind==='ready-ack'){
    const ordinary=submit(2,1);
    switch(scenario){
     case 'negative-epoch':post({...ordinary,epoch:(epoch[0]==='0'?'1':'0')+epoch.slice(1)});break;
     case 'negative-sequence':post({...ordinary,exchangeId:3});break;
     case 'negative-surplus':post({...ordinary,extra:null});break;
     case 'negative-kind':post(request(2,'accepted',1,{accepted:true}));break;
     case 'negative-request-id':post(submit(2,2));break;
     case 'negative-ready':post(request(2,'ready',null));break;
     case 'negative-stale':post(request(1,'status',1));break;
     case 'negative-counter':post({...ordinary,exchangeId:Number.MAX_SAFE_INTEGER+1});break;
     case 'negative-input':post(submit(2,1,'é'.repeat(2048)));break;
     default:post(ordinary);break;
    }
   }else if(reply.kind==='accepted'){
    switch(scenario){
     case 'negative-duplicate':post(submit(2,1));break;
     case 'negative-duplicate-submit':post(submit(3,1));break;
     case 'negative-busy':post(submit(3,2));break;
     case 'negative-retirement-hole':post(request(3,'status',2));break;
     case 'negative-early-ack':post(request(3,'acknowledge-terminal',1));break;
     default:fail();break;
    }
   }else if(reply.kind==='not-accepted'&&scenario==='negative-input'){
    post(request(3,'status',1));
   }else if(reply.kind==='status'&&scenario==='negative-input'){
    post(request(4,'close',null));
   }else if(reply.kind!=='protocol-error'&&reply.kind!=='close-status')fail();
  };
  function initialize(value:unknown):void {
   if(initialized){fail();return;}initialized=true;
   if(value===null||typeof value!=='object'){fail();return;}
   const record=value as Record<string,unknown>,keys=Object.keys(record);
   if(keys.length!==5||!['v','kind','epoch','limits','port'].every(key=>Object.hasOwn(record,key))||record.v!==1||record.kind!=='native-codec-broker-bootstrap'||!isBrokerEpoch(record.epoch)||!(record.port instanceof MessagePort)){fail();return;}
   try{maxResultUnits=validateBrokerLimits(record.limits).maxResultStringUnits;}catch{fail();return;}
   epoch=record.epoch;privatePort=record.port;
   privatePort.on('message',receive);privatePort.once('messageerror',fail);
   privatePort.once('close',()=>{report('wire-closed');finish();});
   post(request(1,'ready',null));
  }
  port.on('message',initialize);port.once('messageerror',badParent);
 });
}
void run().catch(error=>report('fixture-error',{error:errorName(error)})).finally(()=>{
 clearTimeout(watchdog);client?.detach();stopWire?.();report('done');finished=true;port.close();
});
