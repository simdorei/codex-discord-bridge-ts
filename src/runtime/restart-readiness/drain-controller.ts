import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import {AdmissionGate} from '../../admission/drain-gate.ts';
import {DrainFenceKey,getDrainFenceKeyRecord} from '../../admission/owned-key.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {passiveErrorText} from '../../core/passive-error-text.ts';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
import {PosixDrainMarkerStore,encodeRuntimeIdentityMarker,type DrainMarkerStore,type RuntimeMarker} from './drain-marker.ts';
const methods=['prepareExists','ackExists','readIdentity','readPrepare','readAck','readRestart','publishIdentity','publishAck','removeIdentityIfOwned','removeAckIfOwned','stopRequested'] as const;
const TOKEN=Symbol('RuntimeDrainController');
const signalAborted=Object.getOwnPropertyDescriptor(AbortSignal.prototype,'aborted')!.get!;
export type DrainedTransition='Restart'|'Stop';
export type DrainProtocolErrorKind='OrphanedState'|'IdentityMismatch'|'PrepareChanged'|'Disposed'|'WaitAlreadyActive';
export class DrainProtocolError extends Error{
 readonly kind:DrainProtocolErrorKind;
 constructor(kind:DrainProtocolErrorKind){super(kind==='OrphanedState'?'orphaned restart drain state exists; watchdog must prove the former runtime exited':kind==='IdentityMismatch'?'restart drain prepare targets a different runtime identity':kind==='PrepareChanged'?'restart drain prepare changed before acknowledgement':kind==='Disposed'?'runtime drain controller is disposed':'runtime drain transition wait is already active');this.name='DrainProtocolError';this.kind=kind;}
}
/** Capture known native prototype methods rather than accessing overridable
 * instance properties. Windows supplies a separately qualified owned port. */
export function posixDrainMarkerPort(store:PosixDrainMarkerStore):DrainMarkerStore{
 const result:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
 for(const name of methods){const fn=PosixDrainMarkerStore.prototype[name];Object.defineProperty(result,name,{value:(...args:unknown[])=>Reflect.apply(fn,store,args),enumerable:true});}return Object.freeze(result) as unknown as DrainMarkerStore;
}
function capture(input:DrainMarkerStore):DrainMarkerStore{
 const result:Record<string,unknown>=Object.create(null) as Record<string,unknown>;
 for(const name of methods){const fn=own(input,name);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned drain marker operation');Object.defineProperty(result,name,{enumerable:true,value:async(...args:unknown[])=>{const task=Reflect.apply(fn,input,args);if(!types.isPromise(task))throw new TypeError('Expected native marker operation Promise');const value=await task;if(name.endsWith('Exists')||name==='stopRequested'){if(typeof value!=='boolean')throw new TypeError('Invalid marker existence result');}else if(name==='readPrepare'||name==='readAck'||name==='readRestart'){if(value!==null&&getDrainFenceKeyRecord(value)===null)throw new TypeError('Invalid owned drain fence result');}else if(!name.startsWith('read')&&value!==undefined)throw new TypeError('Expected void marker mutation result');return value;}});}return Object.freeze(result) as unknown as DrainMarkerStore;
}
/** Runtime-instance ownership and joined consumers are caller prerequisites.
 * Admission remains sealed throughout transition waiting. Async IO is serialized
 * and rechecks drain state around publication; it is not foreign-process CAS. */
export class RuntimeDrainController{
 readonly #store:DrainMarkerStore;readonly #identity:RuntimeMarker;readonly #gate=new AdmissionGate();readonly #untrusted:DrainFenceKey;
 #tail:Promise<void>=Promise.resolve();#closing=false;#closed=false;#dispose:Promise<void>|null=null;#waiting=false;#claimed:DrainFenceKey|null=null;
 private constructor(token:symbol,store:DrainMarkerStore,identity:RuntimeMarker){if(token!==TOKEN)throw new TypeError('Use RuntimeDrainController.initialize');this.#store=store;this.#identity=identity;this.#untrusted=DrainFenceKey.create(identity.runtimeId,`${identity.processId}|0`,'untrusted-prepare');}
 static async initialize(store:DrainMarkerStore,identityOverride?:RuntimeMarker):Promise<RuntimeDrainController>{
  const port=capture(store);if(await port.prepareExists()||await port.ackExists())throw new DrainProtocolError('OrphanedState');
  const marker=identityOverride===undefined?Object.freeze({runtimeId:randomUUID(),processId:process.pid}):Object.freeze({runtimeId:own(identityOverride,'runtimeId') as string,processId:own(identityOverride,'processId') as number});encodeRuntimeIdentityMarker(marker);DrainFenceKey.create(marker.runtimeId,`${marker.processId}|0`,'untrusted-prepare');
  await port.publishIdentity(marker);return new RuntimeDrainController(TOKEN,port,marker);
 }
 get admissionGate():AdmissionGate{return this.#gate;}get runtimeId():string{return this.#identity.runtimeId;}
 #open(){if(this.#closing||this.#closed)throw new DrainProtocolError('Disposed');}
 #serial<T>(operation:()=>Promise<T>):Promise<T>{this.#open();const task=this.#tail.then(()=>{this.#open();return operation();});this.#tail=task.then(()=>undefined,()=>undefined);return task;}
 quarantineUntrustedPrepare():void{this.#open();AdmissionGate.prototype.seal.call(this.#gate,this.#untrusted);}
 claimPrepare():Promise<DrainFenceKey|null>{return this.#serial(async()=>{const key=await this.#store.readPrepare();if(key===null)return null;const record=getDrainFenceKeyRecord(key)!;if(record.runtimeId!==this.#identity.runtimeId||!record.processIdentity.startsWith(`${this.#identity.processId}|`))throw new DrainProtocolError('IdentityMismatch');AdmissionGate.prototype.seal.call(this.#gate,key);this.#claimed=key;return key;});}
 acknowledge(key:DrainFenceKey):Promise<void>{return this.#serial(async()=>{
  if(getDrainFenceKeyRecord(key)===null||!AdmissionGate.prototype.isDrainedFor.call(this.#gate,key))throw new DrainProtocolError('PrepareChanged');const before=await this.#store.readPrepare();
  if(before===null||!DrainFenceKey.prototype.equals.call(key,before)||!AdmissionGate.prototype.isDrainedFor.call(this.#gate,key))throw new DrainProtocolError('PrepareChanged');
  await this.#store.publishAck(key);const after=await this.#store.readPrepare();if(after===null||!DrainFenceKey.prototype.equals.call(key,after)||!AdmissionGate.prototype.isDrainedFor.call(this.#gate,key)){await this.#store.removeAckIfOwned(key);throw new DrainProtocolError('PrepareChanged');}
 });}
 /** stopSignal represents an explicitly requested stop. Cancellation joins the
  * current marker IO before returning. Polling is millisecond Delay, not a claim
  * of byte-for-byte Tokio timer scheduling or a native Ctrl+C listener. */
 async waitForTransition(key:DrainFenceKey,publishAcknowledgement:boolean,stopSignal:AbortSignal,report:(event:string,error:unknown)=>void=()=>undefined):Promise<DrainedTransition>{
  this.#open();if(this.#waiting)throw new DrainProtocolError('WaitAlreadyActive');if(getDrainFenceKeyRecord(key)===null||typeof publishAcknowledgement!=='boolean')throw new TypeError('Invalid drain transition arguments');if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous drain diagnostic reporter');const aborted=()=>Reflect.apply(signalAborted,stopSignal,[]) as boolean;if(aborted())return 'Stop';if(this.#claimed===null||!DrainFenceKey.prototype.equals.call(key,this.#claimed)||!AdmissionGate.prototype.isSealed.call(this.#gate))throw new DrainProtocolError('PrepareChanged');this.#waiting=true;
  let acknowledged=!publishAcknowledgement,ackFailure:string|null=null,restartFailure:string|null=null;
  const changed=(previous:string|null,event:string,error:unknown)=>{const current=passiveErrorText(error,'drain marker operation failed');if(current!==previous)invokeSynchronousVoid(report,{},[event,error]);return current;};
  try{for(;;){
   this.#open();if(aborted())return 'Stop';if(await this.#store.stopRequested()||aborted())return 'Stop';
   if(!acknowledged){try{await this.acknowledge(key);acknowledged=true;ackFailure=null;}catch(error){ackFailure=changed(ackFailure,'restart_drain_acknowledgement_failed',error);}}
   if(aborted())return 'Stop';
   if(acknowledged){try{const candidate=await this.#store.readRestart();if(aborted())return 'Stop';if(candidate!==null&&DrainFenceKey.prototype.equals.call(key,candidate)&&AdmissionGate.prototype.isDrainedFor.call(this.#gate,key))return 'Restart';restartFailure=null;}catch(error){restartFailure=changed(restartFailure,'restart_drain_restart_marker_read_failed',error);}}
   try{await sleep(100,undefined,{signal:stopSignal});}catch(error){if(!aborted())throw error;}
  }}finally{this.#waiting=false;}
 }
 dispose():Promise<void>{if(this.#dispose!==null)return this.#dispose;if(this.#waiting)throw new DrainProtocolError('WaitAlreadyActive');this.#closing=true;this.#dispose=this.#tail.then(()=>this.#store.removeIdentityIfOwned(this.#identity)).finally(()=>{this.#closed=true;});return this.#dispose;}
}
