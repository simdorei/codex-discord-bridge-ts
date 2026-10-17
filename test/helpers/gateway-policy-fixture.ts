import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {setupPromptRuntime} from './native-server-prompt-runtime-fixture.ts';
import {promptFixture} from './server-prompt-fixture.ts';
import {promptHttpFixture,promptHttpMessage,type PromptHttpRequest} from './server-prompt-http-fixture.ts';
import {historyRetryClock,waitHistoryCondition} from './history-retry-clock.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from './store-authority-worker-fixture.ts';
import {GatewayIngress} from '../../src/discord/gateway/ingress.ts';
import {decodeGatewayMessage} from '../../src/discord/gateway/decoded-message.ts';
import {createPreparedMessageHandler,capturePreparedMessageOptions} from '../../src/runtime/discord-runtime/message-bootstrap.ts';
import {createNativeMirrorPolicyRefresh,refreshMirrorPolicyOffThread,type NativeMirrorPolicyLimits} from '../../src/runtime/discord-runtime/native-mirror-policy.ts';
import {OwnedWorkerSlot,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {runMessageConsumer,type GatewayMessageHandler} from '../../src/runtime/discord-runtime/message-consumer.ts';
export {historyRetryClock,waitHistoryCondition as until};
export const identity={userId:9n,applicationId:4n},limits={maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000},messageId=9007199254740993n;
export const workerName='discord-runtime/mirror-policy-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts');
export const signal=()=>new AbortController().signal;
export const rawMessage=(id=messageId,content='!help',extra:Record<string,unknown>={})=>({...promptHttpMessage(String(id),content),...extra});
export const message=(id=messageId,content='!help',extra:Record<string,unknown>={})=>decodeGatewayMessage(JSON.stringify(rawMessage(id,content,extra)));
export function sql(path:string,query:string){const db=new DatabaseSync(path);try{db.exec(query);}finally{db.close();}}
const waitingWorker=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,15000);parentPort.postMessage(true);"));
export function fillBackground(){const shared=new SharedArrayBuffer(4),slots=[new OwnedWorkerSlot(),new OwnedWorkerSlot(),new OwnedWorkerSlot()],tasks=slots.map(s=>s.run(waitingWorker,shared,10000));let released:Promise<void>|undefined;return {release:()=>released??=(async()=>{Atomics.store(new Int32Array(shared),0,1);Atomics.notify(new Int32Array(shared),0);await Promise.all(tasks);await Promise.all(slots.map(s=>s.join()));})()};}
export async function occupyPolicy(f:ReturnType<typeof setupPromptRuntime>){const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:workerName,trace}),pending=refreshMirrorPolicyOffThread(f.startup.policy,f.path,limits);await waitTrace(trace);let released:Promise<void>|undefined;return {release:()=>released??=(async()=>{restore();releaseTrace(trace);await pending;})()};}
export async function gatewayPolicyFixture(run:(c:{f:ReturnType<typeof setupPromptRuntime>;http:Parameters<typeof createPreparedMessageHandler>[2];seen:PromptHttpRequest[];clock:ReturnType<typeof historyRetryClock>;handler:GatewayMessageHandler;direct:ReturnType<typeof capturePreparedMessageOptions>;owner:GatewayIngress<object>;page:unknown[];now:{value:number}})=>Promise<void>,bounds:NativeMirrorPolicyLimits=limits){
 await promptFixture(async(path,server)=>{const f=setupPromptRuntime(path,server),clock=historyRetryClock(),owner=new GatewayIngress<object>({interactionCapacity:2,reservedInteractionCapacity:2,messageCapacity:2,receiveErrorCapacity:2}),page:unknown[]=[],now={value:102};
  try{await promptHttpFixture(async(http,seen)=>{const options={...f.options,messagePolicyLimits:bounds,policyRetryClock:clock.clock,now:()=>now.value},handler=createPreparedMessageHandler(f.startup,f.gate,http,options),direct={...capturePreparedMessageOptions(f.startup,f.gate,http,options),refreshPolicy:createNativeMirrorPolicyRefresh(path,bounds)};
   await run({f,http,seen,clock,handler,direct,owner,page,now});assert.equal(ownedWorkerUsage().Background,0);
  },(request,_count,response)=>{if(request.method==='GET')response.end(JSON.stringify(page));});}finally{for(const receiver of Object.values(owner.receivers))receiver.dispose();owner.close();}
 },{enableResponses:true});
}
export function consume(owner:GatewayIngress<object>,handler:GatewayMessageHandler,lane:'messages'|'emergencyMessages'='messages'){
 const id=owner.subscribeIdentity(),conflict=owner.subscribeIdentityConflict(),stop=new AbortController(),force=new AbortController();owner.publish({kind:'Ready',identity},1);
 const pending=runMessageConsumer(owner.receivers[lane],id,conflict,stop.signal,force.signal,handler);void pending.catch(()=>{});
 return {pending,stop,force,async close(){stop.abort();await pending;id.dispose();conflict.dispose();},dispose(){id.dispose();conflict.dispose();}};
}
export function publish(owner:GatewayIngress<object>,event=message()){return owner.publish({kind:'Message',event},17);}
