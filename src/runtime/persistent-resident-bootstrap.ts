import {getEnvironmentData,isMainThread} from 'node:worker_threads';
import {pathToFileURL} from 'node:url';
import {types} from 'node:util';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';

export const PERSISTENT_RESIDENT_ROLE_KEY='codex-discord-bridge:persistent-resident-role:v1';
export const PERSISTENT_RESIDENT_HANDSHAKE_MS=5000;
export type PersistentResidentDescriptor=Readonly<{version:1;role:'persistent-resident-v1';module:string;path:string;live:SharedArrayBuffer}>;
export type PersistentResidentBootstrapData=Readonly<{version:1;kind:'persistent-resident-bootstrap';runtimeId:string}>;
/** Pure bootstrap inventory: deliberately imports no store-using graph. */
export function persistentResidentEntryUrl():URL{return new URL(import.meta.url.endsWith('.js')?'./persistent-resident-worker.js':'./persistent-resident-worker.ts',import.meta.url);}
export function isPersistentResidentEntry(filename:string|undefined):boolean{return filename!==undefined&&pathToFileURL(filename).href===persistentResidentEntryUrl().href;}
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(value===null||typeof value!=='object'||types.isProxy(value))throw new TypeError('Expected passive persistent role record');
 const proto=Object.getPrototypeOf(value);if(proto!==Object.prototype&&proto!==null)throw new TypeError('Invalid persistent role prototype');
 const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))throw new TypeError('Invalid persistent role fields');
 const result:Record<string,unknown>=Object.create(null);for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k)!;if(!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Expected passive persistent role field');result[k]=d.value;}return result;
}
function text(value:unknown,max:number):string{
 if(typeof value!=='string'||value.length===0||value.includes('\0')||Buffer.byteLength(value)>max||Buffer.from(value).toString('utf8')!==value)throw new TypeError('Invalid bounded persistent role text');return value;
}
export function capturePersistentResidentPath(value:unknown):string{const path=text(value,32768);if(pinNativeRuntimePath(path)!==path)throw new TypeError('Expected exact pinned persistent store path');return path;}
export function capturePersistentResidentBootstrapData(value:unknown):PersistentResidentBootstrapData{
 const data=exact(value,['version','kind','runtimeId']);if(data.version!==1||data.kind!=='persistent-resident-bootstrap')throw new TypeError('Invalid persistent bootstrap data');return Object.freeze({version:1,kind:'persistent-resident-bootstrap',runtimeId:text(data.runtimeId,4096)});
}
export function capturePersistentResidentDescriptor(value:unknown):PersistentResidentDescriptor{
 const data=exact(value,['version','role','module','path','live']);
 if(data.version!==1||data.role!=='persistent-resident-v1'||text(data.module,65536)!==persistentResidentEntryUrl().href)throw new TypeError('Invalid persistent role module');
 if(typeof data.live!=='object'||data.live===null||types.isProxy(data.live)||!(data.live instanceof SharedArrayBuffer)||Object.getPrototypeOf(data.live)!==SharedArrayBuffer.prototype||Reflect.ownKeys(data.live).length!==0||data.live.byteLength!==4||Atomics.load(new Int32Array(data.live),0)!==1)throw new TypeError('Persistent store registration is not live');
 return Object.freeze({version:1,role:'persistent-resident-v1',module:data.module as string,path:capturePersistentResidentPath(data.path),live:data.live});
}
export function requirePersistentResidentRole():PersistentResidentDescriptor{
 if(isMainThread||!isPersistentResidentEntry(process.argv[1]))throw new TypeError('Expected actual fixed persistent resident entry');
 return capturePersistentResidentDescriptor(getEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY));
}
export function requirePersistentResidentStoreOpen(path:string):void{
 const descriptor=requirePersistentResidentRole();if(capturePersistentResidentPath(path)!==descriptor.path)throw new TypeError('Persistent store path differs from registration');
}
export function persistentResidentFrame(value:unknown,kind:'role-ready'|'close-unstarted'|'unstarted-closed'):boolean{
 try{const data=exact(value,['version','kind']);return data.version===1&&data.kind===kind;}catch{return false;}
}
