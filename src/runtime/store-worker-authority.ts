import {getEnvironmentData,setEnvironmentData,isMainThread} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {anyStoreAuthorityEnrolled,authorityStorePath,beginAuthorityNativeOwner,registerStoreWriter,markStoreWorkerSubmitted,releaseStoreWriter,type StoreWriterTicket} from '../store/store-authority-domain.ts';
import {storeWorkerClassification,storeWorkerPath,requiredStoreWorkerRole} from './store-worker-manifest.ts';
import {requirePersistentResidentRole,requirePersistentResidentStoreOpen} from './persistent-resident-bootstrap.ts';

// A bounded transport descriptor, never a transferable authority capability.
// Only this module may touch this environment-data entry in production.
const key='codex-discord-bridge:store-accounting:v1';
type Descriptor={version:1;module:string;path:string|null;live:SharedArrayBuffer};
type Record={descriptor:Descriptor|undefined;writer:StoreWriterTicket|null;finish:()=>void;submitted:boolean;released:boolean};
declare const workerBrand:unique symbol;
export interface StoreWorkerRegistration{readonly [workerBrand]:never;}
const registrations=new WeakMap<object,Record>();
function record(token:StoreWorkerRegistration):Record{const found=registrations.get(token);if(found===undefined||found.released)throw new TypeError('Expected live private native store registration');return found;}
/** Called synchronously before either lane acquisition or completion FIFO wait. */
export function registerStoreWorker(url:URL,data:unknown):StoreWorkerRegistration{
 if(!isMainThread)throw new TypeError('Native workers must be submitted by the main runtime owner');
 let descriptor:Descriptor|undefined,writer:StoreWriterTicket|null=null;
 if(anyStoreAuthorityEnrolled()){
  const field=storeWorkerClassification(url);if(field===undefined)throw new TypeError('Unknown native module in enrolled store runtime');
  const path=field===null?null:storeWorkerPath(data,field),live=new SharedArrayBuffer(4);Atomics.store(new Int32Array(live),0,1);
  descriptor={version:1,module:url.href,path,live};if(path!==null)writer=registerStoreWriter(path,'Worker');
 }
 const token=Object.freeze({}) as StoreWorkerRegistration;registrations.set(token,{descriptor,writer,finish:beginAuthorityNativeOwner(),submitted:false,released:false});return token;
}
/** No await, message handshake or business-input mutation. Restore even on
 * structured-clone failure. The actual main registration remains private. */
export function constructStoreWorker<T>(token:StoreWorkerRegistration,construct:()=>T):T{
 const entry=record(token);if(entry.submitted)throw new TypeError('Native registration already submitted');
 const prior=getEnvironmentData(key);try{
  setEnvironmentData(key,entry.descriptor);const result=construct();entry.submitted=true;if(entry.writer!==null)markStoreWorkerSubmitted(entry.writer);return result;
 }finally{setEnvironmentData(key,prior);}
}
export function releaseStoreWorker(token:StoreWorkerRegistration,exited:boolean):void{
 const entry=record(token);if(entry.submitted!==exited)throw new TypeError('Native store release requires actual exit');
 entry.released=true;if(entry.descriptor!==undefined)Atomics.store(new Int32Array(entry.descriptor.live),0,0);
 if(entry.writer!==null)releaseStoreWriter(entry.writer,exited?'WorkerExited':'Unsubmitted');entry.finish();
}
let captured:Descriptor|null|undefined;
function workerDescriptor():Descriptor|null{
 if(isMainThread)return null;if(captured!==undefined)return captured;
 const raw=getEnvironmentData(key) as Descriptor|undefined;if(raw===undefined){captured=null;return null;}
 if(raw===null||typeof raw!=='object'||Object.keys(raw).length!==4||raw.version!==1||typeof raw.module!=='string'||raw.module.length>65536||!(raw.live instanceof SharedArrayBuffer)||raw.live.byteLength!==4||raw.path!==null&&(typeof raw.path!=='string'||Buffer.byteLength(raw.path)>65536))throw new TypeError('Invalid native store accounting descriptor');
 const filename=process.argv[1];if(filename===undefined||pathToFileURL(filename).href!==raw.module||storeWorkerClassification(new URL(raw.module))===undefined)throw new TypeError('Native store accounting module differs');
 captured=Object.freeze({version:1,module:raw.module,path:raw.path,live:raw.live});return captured;
}
/** Enrolled workers cannot open a foreign path or use an explicitly read-only
 * module as a writable bridge-store path. This does not confer SQL permission. */
export function requireWorkerStoreOpen(path:string):boolean{
 if(!isMainThread&&process.argv[1]!==undefined&&requiredStoreWorkerRole(pathToFileURL(process.argv[1]))!==undefined){requirePersistentResidentStoreOpen(path);return true;}
 const entry=workerDescriptor();if(entry===null)return false;
 if(entry.path===null||entry.path!==authorityStorePath(path)||Atomics.load(new Int32Array(entry.live),0)!==1)throw new TypeError('Native writable store lacks its live original registration');return true;
}
export function workerStoreAccountingActive():boolean{if(!isMainThread&&process.argv[1]!==undefined&&requiredStoreWorkerRole(pathToFileURL(process.argv[1]))!==undefined){requirePersistentResidentRole();return true;}return workerDescriptor()!==null;}
