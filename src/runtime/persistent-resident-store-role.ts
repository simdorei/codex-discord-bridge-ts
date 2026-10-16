import {types} from 'node:util';
import {PersistentResidentServicesOwner} from './persistent-resident-services-owner.ts';
import {createMainSequentialMutationBroker,type MainSequentialMutationBroker} from './sequential-mutation-broker-owner.ts';
import type {SequentialMutationBrokerLimits} from './sequential-mutation-broker-protocol.ts';
import {PERSISTENT_RESIDENT_CHILD_CLOSURES,type PersistentResidentChildClosure,PERSISTENT_RESIDENT_SCENARIOS,PERSISTENT_RESIDENT_COMPONENT_PHASES,PERSISTENT_RESIDENT_FIXTURE_FAILURE_STEPS,type PersistentResidentScenario} from './persistent-resident-bootstrap.ts';
import {Worker,isMainThread,getEnvironmentData,setEnvironmentData} from 'node:worker_threads';
import {registerStoreWriter,markStoreWorkerSubmitted,releaseStoreWriter,beginAuthorityNativeOwner,type StoreWriterTicket} from '../store/store-authority-domain.ts';
import {ownedWorkerModuleUrl} from './owned-worker-slot.ts';
import {PERSISTENT_RESIDENT_ROLE_KEY,PERSISTENT_RESIDENT_HANDSHAKE_MS,capturePersistentResidentPath,capturePersistentResidentBootstrapData,capturePersistentResidentDescriptor,persistentResidentFrame,type PersistentResidentDescriptor} from './persistent-resident-bootstrap.ts';

declare const registrationBrand:unique symbol;
export interface PersistentResidentRegistration{readonly [registrationBrand]:never;}
type Registration={descriptor:PersistentResidentDescriptor;writer:StoreWriterTicket;finish:()=>void;submitted:boolean;released:boolean};
const registrations=new WeakMap<object,Registration>();
// Active normal-component debt is separate from preparation-only lifetime.
const activeComponentPaths=new Map<string,Registration>();
function record(token:PersistentResidentRegistration):Registration{const entry=registrations.get(token);if(entry===undefined||entry.released)throw new TypeError('Expected live private persistent registration');return entry;}
/** Internal preparation bookkeeping, not an acquired root or store authority. */
export function createPersistentResidentRegistration(path:string):PersistentResidentRegistration{
 if(!isMainThread)throw new TypeError('Persistent registration requires main owner');
 const pinned=capturePersistentResidentPath(path);if(activeComponentPaths.has(pinned))throw new Error('Original resident component root debt retained');
 const url=ownedWorkerModuleUrl(new URL('./persistent-resident-worker.ts',import.meta.url),import.meta.url),live=new SharedArrayBuffer(4);Atomics.store(new Int32Array(live),0,1);
 const descriptor=capturePersistentResidentDescriptor({version:1,role:'persistent-resident-v1',module:url.href,path:pinned,live}),writer=registerStoreWriter(pinned,'Worker');
 const token=Object.freeze({}) as PersistentResidentRegistration;registrations.set(token,{descriptor,writer,finish:beginAuthorityNativeOwner(),submitted:false,released:false});return token;
}
function release(entry:Registration):void{if(entry.released)throw new TypeError('Persistent registration already released');entry.released=true;Atomics.store(new Int32Array(entry.descriptor.live),0,0);releaseStoreWriter(entry.writer,entry.submitted?'WorkerExited':'Unsubmitted');entry.finish();if(activeComponentPaths.get(entry.descriptor.path)===entry)activeComponentPaths.delete(entry.descriptor.path);}
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

// Frozen 948 disposable profile; its native transport and precise local refusal
// receipts remain unchanged. This is not a production capacity default.
const NORMAL_COMPONENT_MUTATION_PROFILE=Object.freeze({maxClaimUtf8Bytes:1048576,maxClaimStringUnits:1048576,maxClaimNodes:65536,maxClaimEdges:65536,maxClaimDepth:64,maxContainerEntries:65536,maxNativeResultUtf8Bytes:16384,maxRetainedLogicalBytes:22249600,maxRetainedNodes:393488,maxRetainedEdges:393484,nativeTimeoutMs:5000,handshakeTimeoutMs:5000,exchangeTimeoutMs:5000,preparedAwaitFinishTimeoutMs:5000,terminalRetentionMs:5000,minStatusIntervalMs:1,phaseObservationTimeoutMs:10000,maxOperationId:2147483647,maxExchangeId:2147483647} satisfies SequentialMutationBrokerLimits);
type ComponentState='bootstrapping'|'role-ready'|'fence-ready'|'custody-ready'|'mutation-handshake'|'starting'|'ready'|'running'|'fixture-done'|'closing'|'disposed'|'joined'|'quarantined';
export interface PersistentResidentFixtureResult {readonly scenario:PersistentResidentScenario;readonly passed:true}
export interface PersistentResidentNormalComponent {
 ready():Promise<void>;
 runFixture(scenario:PersistentResidentScenario):Promise<PersistentResidentFixtureResult>;
 closeComponent():Promise<void>;
 join():Promise<void>;
 snapshot():Readonly<{state:ComponentState;submitted:boolean;exited:boolean;registrationLive:boolean;rootDebt:boolean;runtimeStarted:boolean;servicesClosed:boolean;mutationJoined:boolean;directChildClosure:PersistentResidentChildClosure}>;
}
function componentReport(value:unknown):Record<string,unknown>{
 if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))throw new TypeError('Invalid fixed resident component report');
 const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)throw new TypeError('Invalid fixed resident component report');
 const kindDescriptor=Object.getOwnPropertyDescriptor(value,'kind');
 if(!kindDescriptor||!Object.hasOwn(kindDescriptor,'value')||typeof kindDescriptor.value!=='string')throw new TypeError('Invalid fixed resident component report');
 const keys=kindDescriptor.value==='fixture-result'?['version','kind','scenario','passed']:kindDescriptor.value==='component-failed'?['version','kind','phase','category','fixtureStep','childClosure']:kindDescriptor.value==='component-disposed'?['version','kind','childClosure']:['version','kind'];
 const actual=Reflect.ownKeys(value);if(actual.length!==keys.length||actual.some(k=>typeof k!=='string'||!keys.includes(k)))throw new TypeError('Invalid fixed resident component report');
 const result:Record<string,unknown>=Object.create(null);
 for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Invalid fixed resident component report');result[key]=d.value;}
 if(result.version!==1)throw new TypeError('Invalid fixed resident component report');
 if(result.kind==='component-failed'&&(typeof result.phase!=='string'||!PERSISTENT_RESIDENT_COMPONENT_PHASES.some(phase=>phase===result.phase)||(result.category!=='protocol'&&result.category!=='lifecycle')||typeof result.fixtureStep!=='string'||!PERSISTENT_RESIDENT_FIXTURE_FAILURE_STEPS.some(step=>step===result.fixtureStep)))throw new TypeError('Invalid fixed resident component failure');
 if((result.kind==='component-failed'||result.kind==='component-disposed')&&!PERSISTENT_RESIDENT_CHILD_CLOSURES.some(value=>value===result.childClosure))throw new TypeError('Invalid direct child closure diagnostic');
 return result;
}
/** Disposable normal lifecycle component only, never called by main startup.
 * No singleton guard is minted here. Original child-exit proof remains in the
 * fixed worker lifecycle. Actual requester exit clears liveness, not root debt. */
export function createPersistentResidentNormalComponent(token:PersistentResidentRegistration,runtimeId:string):PersistentResidentNormalComponent{
 if(!isMainThread)throw new TypeError('Persistent component requires main owner');
 const entry=record(token);if(entry.submitted||activeComponentPaths.has(entry.descriptor.path))throw new TypeError('Original component registration unavailable');
 const data=capturePersistentResidentBootstrapData({version:1,kind:'persistent-resident-component',runtimeId});
 activeComponentPaths.set(entry.descriptor.path,entry);
 let worker:Worker,services:PersistentResidentServicesOwner,mutation:MainSequentialMutationBroker|null=null;
 let state:ComponentState='bootstrapping',exited=false,normalReport=false,runtimeStarted=false,lifecycleMayExist=false,scenario:PersistentResidentScenario|null=null;
 let reportCorrupt=false,terminalKind:'none'|'failed'|'disposed'='none';
 let directChildClosure:PersistentResidentChildClosure='unknown';
 let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,closeResolve!:()=>void,closeReject!:(error:unknown)=>void,joinResolve!:()=>void,joinReject!:(error:unknown)=>void;
 let runResolve:((result:PersistentResidentFixtureResult)=>void)|null=null,runReject:((error:unknown)=>void)|null=null;
 const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
 const closed=new Promise<void>((resolve,reject)=>{closeResolve=resolve;closeReject=reject;});
 const joined=new Promise<void>((resolve,reject)=>{joinResolve=resolve;joinReject=reject;});
 void ready.catch(()=>undefined);void closed.catch(()=>undefined);void joined.catch(()=>undefined);
 let timer:ReturnType<typeof setTimeout>|null=null,cleanup:Promise<void>|null=null;
 let failurePhase:ComponentState|null=null,workerFailurePhase:string|null=null,workerFailureCategory:'protocol'|'lifecycle'|null=null,workerFixtureStep='none';
 // All diagnostics are closed phase/category labels, never received error text.
 const fixedError=()=>new Error(`Original resident component unconfirmed; main phase=${failurePhase??state}${workerFailurePhase===null?'':`; worker phase=${workerFailurePhase}; category=${workerFailureCategory}; fixture step=${workerFixtureStep}`}; root debt retained; no automatic retry`);
 const clearTimer=()=>{if(timer!==null)clearTimeout(timer);timer=null;};
 const startupCleanup=():Promise<void>=>{
  if(cleanup!==null)return cleanup;
  cleanup=(async()=>{
   await services.closeStartupService('dead');
   if(mutation!==null){mutation.quarantine();await mutation.join();}
   await services.closeStartupService('response');
   await services.closeStartupService('idle');
   await services.closeStartupService('verify');
   await services.closeStartupService('gap');
  })();void cleanup.catch(()=>undefined);return cleanup;
 };
 const fail=()=>{
  if(state==='quarantined'||state==='joined')return;failurePhase=state;state='quarantined';clearTimer();
  const error=fixedError();readyReject(error);closeReject(error);runReject?.(error);runResolve=null;runReject=null;
  // Before lifecycle construction, use original startup cleanup ordering. Once
  // the worker may own a child, it alone owns disposal/exit settlement: leave
  // idle admissible for that path. Missing proof still permanently retains debt.
  // There is no forced termination and no parent inference of child exit.
  if(!lifecycleMayExist)void startupCleanup().catch(()=>undefined);
 };
 // Sticky independently of fail() idempotence, including after quarantine.
 // A genuinely late callback cannot undo an already completed release.
 const corruptReport=()=>{reportCorrupt=true;directChildClosure='unknown';fail();};
 const deadline=()=>{clearTimer();timer=setTimeout(fail,PERSISTENT_RESIDENT_HANDSHAKE_MS);};
 const post=(message:object)=>{try{worker.postMessage(message);}catch{fail();throw fixedError();}};
 const prior=getEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY);
 try{
  setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,entry.descriptor);
  worker=new Worker(new URL(entry.descriptor.module),{workerData:data});
  // Attached before any subsequent constructor can fail: only actual exit
  // revokes the live role descriptor, never an inferred constructor failure.
  worker.once('exit',()=>Atomics.store(new Int32Array(entry.descriptor.live),0,0));
  entry.submitted=true;markStoreWorkerSubmitted(entry.writer);
  services=new PersistentResidentServicesOwner(entry.descriptor.path,runtimeId,null,worker);
  worker.once('error',fail);worker.once('messageerror',corruptReport);
  worker.once('exit',code=>{
   if(exited)return;exited=true;clearTimer();
   // The worker can no longer open through this descriptor, but its registration
   // and native-owner accounting survive until all independent normal proofs.
   Atomics.store(new Int32Array(entry.descriptor.live),0,0);
   if(code!==0||reportCorrupt||terminalKind!=='disposed'||!normalReport||state!=='disposed')fail();
   void (async()=>{
    try{
     if(cleanup!==null)await cleanup;
     await services.join();if(mutation!==null)await mutation.join();
     if(state!=='quarantined'&&code===0&&!reportCorrupt&&terminalKind==='disposed'&&normalReport&&services.releasable&&mutation?.snapshot().state==='J'){
      release(entry);state='joined';closeResolve();
     }else{fail();}
     joinResolve();
    }catch{fail();joinReject(fixedError());}
   })();
  });
  worker.on('message',(raw:unknown)=>{
   try{
    const report=componentReport(raw),kind=report.kind;
    if(exited||reportCorrupt||terminalKind!=='none')throw fixedError();
    if(kind==='component-failed'||kind==='component-disposed'){
     const closure=report.childClosure;
     if(closure==='confirmed'&&(!lifecycleMayExist||scenario==='normal-replacement'||(kind==='component-failed'&&!['starting','ready','running','ran','closing'].includes(report.phase as string))))throw fixedError();
     if(closure==='not-started'&&(kind==='component-disposed'||runtimeStarted||(kind==='component-failed'&&!['loading','services','activating','mutation','mutation-handshake','initialized','starting'].includes(report.phase as string))))throw fixedError();
    }
    if(kind==='component-failed'){
     if(typeof report.phase!=='string'||typeof report.fixtureStep!=='string'||(report.category!=='protocol'&&report.category!=='lifecycle'))throw fixedError();
     if(report.phase==='failed'||report.phase==='closed'||state==='joined'||state==='disposed')throw fixedError();
     terminalKind='failed';directChildClosure=report.childClosure as PersistentResidentChildClosure;
     workerFailurePhase=report.phase;workerFailureCategory=report.category;workerFixtureStep=report.fixtureStep;fail();return;
    }
    if(state==='bootstrapping'&&kind==='role-ready'){state='role-ready';deadline();return;}
    if(state==='role-ready'&&kind==='local-fence-ready'){
     state='fence-ready';services.bindRequester();deadline();return;
    }
    if(state==='fence-ready'&&kind==='custody-ready'){
     state='custody-ready';deadline();
     void services.custodyActivated.then(()=>{
      if(state!=='custody-ready')return;
      mutation=createMainSequentialMutationBroker(entry.descriptor.path,runtimeId,NORMAL_COMPONENT_MUTATION_PROFILE);
      state='mutation-handshake';mutation.bindRequester(worker);deadline();
     }).catch(fail);return;
    }
    if(state==='mutation-handshake'&&kind==='mutation-ready'){
     if(mutation?.snapshot().state!=='R')throw fixedError();
     services.initializeRemainingOwners();state='starting';lifecycleMayExist=true;post({version:1,kind:'services-initialized'});deadline();return;
    }
    if(state==='starting'&&kind==='component-ready'){
     state='ready';runtimeStarted=true;clearTimer();readyResolve();return;
    }
    if(state==='running'&&kind==='fixture-result'){
     if(report.scenario!==scenario||report.passed!==true)throw fixedError();
     state='fixture-done';clearTimer();const resolve=runResolve;runResolve=null;runReject=null;
     resolve?.(Object.freeze({scenario:scenario!,passed:true}));return;
    }
    if(state==='closing'&&kind==='component-disposed'){
     if(!services.servicesClosed||mutation?.snapshot().state!=='C')throw fixedError();
     services.notifyNormalResidentDisposed();terminalKind='disposed';directChildClosure=report.childClosure as PersistentResidentChildClosure;normalReport=true;state='disposed';deadline();return;
    }
    throw fixedError();
   }catch{corruptReport();}
  });
  void services.custodyActivated.catch(fail);deadline();
 }catch(error){
  if(!entry.submitted)release(entry);
  // Once submitted, construction failure retains registration debt. It must not
  // turn an observed Worker construction into an unsubmitted release.
  throw error;
 }finally{setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,prior);}
 return Object.freeze({
  ready:()=>ready,
  runFixture(selected:PersistentResidentScenario):Promise<PersistentResidentFixtureResult>{
   if(state!=='ready'||scenario!==null||!PERSISTENT_RESIDENT_SCENARIOS.includes(selected))return Promise.reject(new TypeError('Fixed fixture unavailable or already initiated'));
   scenario=selected;state='running';
   const pending=new Promise<PersistentResidentFixtureResult>((resolve,reject)=>{runResolve=resolve;runReject=reject;});void pending.catch(()=>undefined);
   // Fixture work has its own fixed ten-second observation phase, independent
   // from native five-second deadlines. Failure retains ownership, never retries.
   clearTimer();timer=setTimeout(fail,10000);
   try{post({kind:'run-fixture',scenario:selected});}catch{/* Fixed promise rejected by fail. */}return pending;
  },
  closeComponent():Promise<void>{
   if(state==='closing'||state==='disposed'||state==='joined'||state==='quarantined')return closed;
   if(state!=='fixture-done'||scenario===null)return Promise.reject(new Error('Complete the single fixed fixture before component close'));
   state='closing';deadline();try{post({kind:'close-component'});}catch{/* Fixed close promise owns failure. */}return closed;
  },
  join:()=>joined,
  snapshot:()=>Object.freeze({state,submitted:entry.submitted,exited,registrationLive:Atomics.load(new Int32Array(entry.descriptor.live),0)===1,rootDebt:!entry.released,runtimeStarted,servicesClosed:services.servicesClosed,mutationJoined:mutation?.snapshot().state==='J',directChildClosure}),
 });
}
