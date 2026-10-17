import {parentPort,workerData} from 'node:worker_threads';
import {types} from 'node:util';
import {capturePersistentResidentBootstrapData,requirePersistentResidentRole,persistentResidentFrame,capturePersistentResidentFixtureCommand,PERSISTENT_RESIDENT_HANDSHAKE_MS} from './persistent-resident-bootstrap.ts';
import type {createPersistentResidentServicesClient} from './persistent-resident-services-client.ts';
import type {SequentialMutationClient} from './sequential-mutation-broker-client.ts';
import type {PersistentResidentComponentPhase,PersistentResidentFixtureFailureStep,PersistentResidentChildClosure} from './persistent-resident-bootstrap.ts';
import type {ServiceEndpointDescriptor} from './persistent-resident-services-protocol.ts';
import type {PortableResidentLifecycle} from '../app-server/portable-resident-lifecycle.ts';
import type {PersistentReceiverServicesClient} from './persistent-receiver-client.ts';
import type {ReceiverDescriptor} from './persistent-receiver-protocol.ts';

// This mandatory bootstrap executes before any store-using dynamic import.
requirePersistentResidentRole();
const data=capturePersistentResidentBootstrapData(workerData);
if(parentPort===null)throw new TypeError('Persistent preparation requires original parent port');
const port=parentPort;
if(data.kind==='persistent-resident-bootstrap'){
 const timer=setTimeout(()=>{port.close();throw new Error('Persistent preparation handshake timed out');},PERSISTENT_RESIDENT_HANDSHAKE_MS);
 let closed=false;
 port.on('message',(message:unknown)=>{
  if(closed||!persistentResidentFrame(message,'close-unstarted')){clearTimeout(timer);port.close();throw new TypeError('Invalid persistent preparation command');}
  closed=true;clearTimeout(timer);port.postMessage({version:1,kind:'unstarted-closed'});port.close();
 });
 port.on('messageerror',()=>{clearTimeout(timer);port.close();throw new TypeError('Invalid persistent preparation message');});
 port.postMessage({version:1,kind:'role-ready'});
}else{
 type Services=ReturnType<typeof createPersistentResidentServicesClient>;
 type Phase=PersistentResidentComponentPhase;
 let phase:Phase='loading',services:Services|null=null,mutation:SequentialMutationClient|null=null,resident:PortableResidentLifecycle|null=null,receiver:PersistentReceiverServicesClient|null=null;
 const currentPhase=():Phase=>phase;
 let fixtureStep:PersistentResidentFixtureFailureStep='none';
 let startEntered=false,replacementMayHaveStarted=false;
 let startAttempt:Promise<PortableResidentLifecycle>|null=null,disposal:Promise<void>|null=null;
 // Receiver/native join and resident/child disposal remain separate obligations.
 // In particular a failed control channel cannot prevent original child cleanup.
 let receiverStop:Promise<void>|null=null;
 function stopReceiver():Promise<void>{
  if(receiverStop!==null)return receiverStop;
  receiverStop=(async()=>{
   if(startAttempt!==null)resident=await startAttempt;
   if(resident!==null){const {stopPersistentResidentReceiver}=await import('./persistent-resident-composition.ts');await stopPersistentResidentReceiver(resident);}
   if(receiver!==null){await receiver.close();if(!receiver.closed||!receiver.joined)throw new Error('Original receiver services have not joined');}
  })();void receiverStop.catch(()=>undefined);return receiverStop;
 }
 let disposalOutcome:{kind:'pending'}|{kind:'fulfilled'}|{kind:'rejected';error:unknown}={kind:'pending'};
 // The shared promise is assigned before disposal can invoke any original owner.
 // A rejected disposal, including thrown undefined, is never retried.
 function disposeOriginal():Promise<void>{
  if(disposal!==null)return disposal;
  disposal=Promise.resolve().then(async()=>{
   if(startAttempt!==null)resident=await startAttempt;
   if(resident!==null)await resident.dispose();
  });
  void disposal.then(()=>{disposalOutcome={kind:'fulfilled'};},error=>{disposalOutcome={kind:'rejected',error};});
  return disposal;
 }
 function childClosure():PersistentResidentChildClosure{
  if(!startEntered&&phase==='failed')return 'not-started';
  // Valid only for this frozen composition: no automatic restart supervisor.
  // Any additional replacement route must disable this positive eligibility.
  return resident!==null&&!replacementMayHaveStarted&&disposalOutcome.kind==='fulfilled'?'confirmed':'unknown';
 }
 let timer:ReturnType<typeof setTimeout>|undefined;
 let acceptServices!:(value:unknown)=>void,acceptInitialized!:(value:Readonly<{receiverServices:unknown;fixtureObservation:SharedArrayBuffer}>)=>void;
 const serviceFrame=new Promise<unknown>(resolve=>{acceptServices=resolve;}),initialized=new Promise<Readonly<{receiverServices:unknown;fixtureObservation:SharedArrayBuffer}>>(resolve=>{acceptInitialized=resolve;});
 const setPhase=(next:Phase)=>{phase=next;clearTimeout(timer);if(!['ready','running','ran','closing','closed','failed'].includes(next))timer=setTimeout(failProtocol,PERSISTENT_RESIDENT_HANDSHAKE_MS);};
 const plain=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
  if(value===null||typeof value!=='object'||types.isProxy(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new TypeError('Invalid component frame');
  const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))throw new TypeError('Invalid component fields');
  for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Invalid component field');}return value as Record<string,unknown>;
 };
 const report=(kind:string)=>port.postMessage({version:1,kind});
 function failProtocol():void{fail(true);}
 function failLifecycle():void{fail(false);}
 function fail(protocolCorruption:boolean):void{
  if(phase==='failed'){if(protocolCorruption){services?.quarantine();mutation?.quarantine(null);}return;}
  if(phase==='closed')return;const failedPhase=phase,failedStep=fixtureStep;setPhase('failed');if(protocolCorruption){services?.quarantine();mutation?.quarantine(null);}process.exitCode=1;
  // Retain this promise, but never await it before attempting actual resident
  // disposal. Missing receiver-service join cannot masquerade as normal cleanup.
  void stopReceiver().catch(()=>undefined);
  // Disposal still attempts the original child cleanup. Failure never reports clean.
  void (async()=>{try{await disposeOriginal();}catch{/* Rejected outcome is retained by the one original disposal observer. */}finally{services?.quarantine();mutation?.quarantine(null);}try{port.postMessage({version:1,kind:'component-failed',phase:failedPhase,category:protocolCorruption?'protocol':'lifecycle',fixtureStep:failedStep,childClosure:childClosure()});}finally{port.close();}})().catch(()=>{process.exitCode=1;port.close();});
 }
 // Installed before either bootstrap client; this fixed dispatcher owns all parent
 // traffic, including duplicate bootstraps after the 948 listener transfers ownership.
 port.on('message',(value:unknown)=>{
  try{
   if(phase==='services'){
    const frame=plain(value,['version','kind','endpoints']);if(frame.version!==1||frame.kind!=='native-services')throw new TypeError('Expected fixed service bootstrap');
    setPhase('activating');acceptServices(frame.endpoints);return;
   }
   if(phase==='mutation'){
    const frame=plain(value,['version','kind','epoch','limits','port']);if(frame.version!==2||frame.kind!=='sequential-mutation-broker-bootstrap')throw new TypeError('Expected fixed mutation bootstrap');
    setPhase('mutation-handshake');return; // Original 948 listener validates and owns this port.
   }
   if(phase==='initialized'){
    const frame=plain(value,['version','kind','receiverServices','fixtureObservation']);if(frame.version!==1||frame.kind!=='services-initialized')throw new TypeError('Expected initialized native owners');
    const observation=frame.fixtureObservation;
    if(observation===null||typeof observation!=='object'||types.isProxy(observation)||!(observation instanceof SharedArrayBuffer)||Object.getPrototypeOf(observation)!==SharedArrayBuffer.prototype||Reflect.ownKeys(observation).length!==0||observation.byteLength!==16)throw new TypeError('Invalid fixed receiver observation');
    setPhase('starting');acceptInitialized(Object.freeze({receiverServices:frame.receiverServices,fixtureObservation:observation}));return;
   }
   if(phase==='ready'){
    const command=capturePersistentResidentFixtureCommand(value);if(command.kind!=='run-fixture')throw new TypeError('Run the fixed fixture once before close');setPhase('running');if(command.scenario==='normal-replacement')replacementMayHaveStarted=true;
    void (async()=>{const {runPersistentResidentFixture,getPersistentResidentFixtureFailureStep}=await import('./persistent-resident-composition.ts');let result;try{result=await runPersistentResidentFixture(resident!,command.scenario);}catch(error){fixtureStep=getPersistentResidentFixtureFailureStep(resident!);throw error;}if(currentPhase()!=='running')return;setPhase('ran');port.postMessage({version:1,kind:result.scenario==='mutation-cancel-after-write'?'fixture-negative-result':'fixture-result',...result});})().catch(failLifecycle);return;
   }
   if(phase==='ran'){
    const command=capturePersistentResidentFixtureCommand(value);if(command.kind!=='close-component')throw new TypeError('Expected final component close');setPhase('closing');
    void (async()=>{await stopReceiver();await disposeOriginal();if(currentPhase()!=='closing')return;setPhase('closed');port.postMessage({version:1,kind:'component-disposed',childClosure:childClosure()});port.close();})().catch(failLifecycle);return;
   }
   throw new TypeError('Unexpected fixed component phase frame');
  }catch{failProtocol();}
 });
 port.on('messageerror',failProtocol);port.on('close',()=>{if(phase!=='closed'&&phase!=='failed')failProtocol();});
 setPhase('loading');report('role-ready');
 void (async()=>{
  const {preparePersistentResidentComposition}=await import('./persistent-resident-composition.ts');
  const prepared=preparePersistentResidentComposition(data.runtimeId);
  if(currentPhase()==='failed')return;setPhase('services');report('local-fence-ready');
  const endpoints=await serviceFrame;
  const {createPersistentResidentServicesClient}=await import('./persistent-resident-services-client.ts');
  services=createPersistentResidentServicesClient(data.runtimeId,endpoints as Parameters<typeof createPersistentResidentServicesClient>[1]);
  // Client construction has validated the exact passive descriptor inventory.
  // This original endpoint reference stays inside fixed worker construction.
  const responsePort=(endpoints as readonly ServiceEndpointDescriptor[]).find(endpoint=>endpoint.service==='response')!.port;
  if(currentPhase()==='failed'){services.quarantine();return;}await services.ready();await services.activateCustody();
  const {receivePersistentResidentMutationClient}=await import('./sequential-mutation-broker-client.ts');
  if(currentPhase()==='failed')return;setPhase('mutation');const pendingMutation=receivePersistentResidentMutationClient();report('custody-ready');
  mutation=await pendingMutation;if(currentPhase()==='failed'){mutation.quarantine(null);return;}setPhase('initialized');report('mutation-ready');
  const frame=await initialized;if(currentPhase()==='failed')return;
  const {PersistentReceiverServicesClient}=await import('./persistent-receiver-client.ts');
  receiver=new PersistentReceiverServicesClient(requirePersistentResidentRole().path,frame.receiverServices as ReceiverDescriptor);
  receiver.failure.addEventListener('abort',failProtocol,{once:true});
  if(receiver.failure.aborted){failProtocol();return;}await receiver.ready();if(currentPhase()==='failed')return;startEntered=true;
  startAttempt=prepared.start(services,mutation,responsePort,receiver,frame.fixtureObservation);resident=await startAttempt;
  if(currentPhase()==='failed'){await disposeOriginal();return;}setPhase('ready');report('component-ready');
 })().catch(failLifecycle);
}
