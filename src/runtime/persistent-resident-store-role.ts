import {Worker,isMainThread,getEnvironmentData,setEnvironmentData} from 'node:worker_threads';
import {registerStoreWriter,markStoreWorkerSubmitted,releaseStoreWriter,beginAuthorityNativeOwner,type StoreWriterTicket} from '../store/store-authority-domain.ts';
import {ownedWorkerModuleUrl} from './owned-worker-slot.ts';
import {PERSISTENT_RESIDENT_ROLE_KEY,PERSISTENT_RESIDENT_HANDSHAKE_MS,capturePersistentResidentPath,capturePersistentResidentBootstrapData,capturePersistentResidentDescriptor,persistentResidentFrame,type PersistentResidentDescriptor} from './persistent-resident-bootstrap.ts';

declare const registrationBrand:unique symbol;
export interface PersistentResidentRegistration{readonly [registrationBrand]:never;}
type Registration={descriptor:PersistentResidentDescriptor;writer:StoreWriterTicket;finish:()=>void;submitted:boolean;released:boolean};
const registrations=new WeakMap<object,Registration>();
function record(token:PersistentResidentRegistration):Registration{const entry=registrations.get(token);if(entry===undefined||entry.released)throw new TypeError('Expected live private persistent registration');return entry;}
/** Internal preparation bookkeeping, not an acquired root or store authority. */
export function createPersistentResidentRegistration(path:string):PersistentResidentRegistration{
 if(!isMainThread)throw new TypeError('Persistent registration requires main owner');
 const pinned=capturePersistentResidentPath(path),url=ownedWorkerModuleUrl(new URL('./persistent-resident-worker.ts',import.meta.url),import.meta.url),live=new SharedArrayBuffer(4);Atomics.store(new Int32Array(live),0,1);
 const descriptor=capturePersistentResidentDescriptor({version:1,role:'persistent-resident-v1',module:url.href,path:pinned,live}),writer=registerStoreWriter(pinned,'Worker');
 const token=Object.freeze({}) as PersistentResidentRegistration;registrations.set(token,{descriptor,writer,finish:beginAuthorityNativeOwner(),submitted:false,released:false});return token;
}
function release(entry:Registration):void{if(entry.released)throw new TypeError('Persistent registration already released');entry.released=true;Atomics.store(new Int32Array(entry.descriptor.live),0,0);releaseStoreWriter(entry.writer,entry.submitted?'WorkerExited':'Unsubmitted');entry.finish();}
export interface PersistentResidentPreparation{
 readonly ready:Promise<void>;
 closeUnstarted():Promise<void>;
 join():Promise<void>;
 snapshot():Readonly<{state:'bootstrapping'|'role-ready'|'closing'|'joined'|'quarantined';submitted:boolean;exited:boolean;registrationLive:boolean;rootDebt:boolean;runtimeStarted:false}>;
}
/** Fixed construction only. No callback, Worker, port or selectable URL escapes. */
export function constructPersistentResidentWorker(token:PersistentResidentRegistration,runtimeId:string):PersistentResidentPreparation{
 if(!isMainThread)throw new TypeError('Persistent construction requires main owner');
 const entry=record(token);if(entry.submitted)throw new TypeError('Persistent registration already submitted');
 let worker:Worker;
 let state:'bootstrapping'|'role-ready'|'closing'|'joined'|'quarantined'='bootstrapping',exited=false,closedReport=false;
 let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,joinResolve!:()=>void,closeResolve!:()=>void,closeReject!:(error:unknown)=>void;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}),joined=new Promise<void>(resolve=>{joinResolve=resolve;}),closed=new Promise<void>((resolve,reject)=>{closeResolve=resolve;closeReject=reject;});
 // Rejections remain observable through the returned originals, without an
 // unhandled rejection if exit precedes the caller attaching its observers.
 void ready.catch(()=>{});void closed.catch(()=>{});
 let timer:ReturnType<typeof setTimeout>|undefined;
 const fail=(error:unknown)=>{if(state==='joined'||state==='quarantined')return;state='quarantined';clearTimeout(timer);readyReject(error);closeReject(error);};
 const prior=getEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY);
 try{
  const data=capturePersistentResidentBootstrapData({version:1,kind:'persistent-resident-bootstrap',runtimeId});
  setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,entry.descriptor);
  worker=new Worker(new URL(entry.descriptor.module),{workerData:data});
  // These listeners are attached synchronously to the original returned Worker.
  worker.on('error',fail);
  worker.once('exit',code=>{
   if(exited)return;exited=true;clearTimeout(timer);release(entry);
   if(code===0&&closedReport&&state==='closing'){state='joined';closeResolve();}else fail(new Error('Persistent preparation exited without clean unstarted close'));
   joinResolve();
  });
  entry.submitted=true;markStoreWorkerSubmitted(entry.writer);
  worker.on('message',(message:unknown)=>{
   if(state==='bootstrapping'&&persistentResidentFrame(message,'role-ready')){state='role-ready';clearTimeout(timer);readyResolve();return;}
   if(state==='closing'&&!closedReport&&persistentResidentFrame(message,'unstarted-closed')){closedReport=true;return;}
   fail(new TypeError('Invalid persistent preparation report'));
  });
  worker.on('messageerror',()=>fail(new TypeError('Invalid persistent preparation message')));
  timer=setTimeout(()=>fail(new Error('Persistent preparation handshake timed out')),PERSISTENT_RESIDENT_HANDSHAKE_MS);
 }catch(error){if(!entry.submitted)release(entry);throw error;}
 finally{setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,prior);}
 return Object.freeze({ready,closeUnstarted():Promise<void>{
  if(state==='closing'||state==='joined')return closed;
  if(state!=='role-ready')return Promise.reject(new Error('Persistent preparation is not role-ready'));
  state='closing';timer=setTimeout(()=>fail(new Error('Persistent unstarted close timed out')),PERSISTENT_RESIDENT_HANDSHAKE_MS);
  try{worker.postMessage({version:1,kind:'close-unstarted'});}catch(error){fail(error);}return closed;
 },join:()=>joined,snapshot:()=>Object.freeze({state,submitted:entry.submitted,exited,registrationLive:!entry.released,rootDebt:state!=='joined',runtimeStarted:false as const})});
}
