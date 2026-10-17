import {isMainThread} from 'node:worker_threads';
import {types} from 'node:util';
import {pinNativeRuntimePath} from '../runtime/runtime-paths/path-text.ts';

/** Accounting for one exact captured path spelling. This is deliberately NOT
 * physical-file identity, exclusion, or permission to replace a final DB check. */
declare const writerBrand:unique symbol;
export interface StoreWriterTicket{readonly [writerBrand]:never;}
declare const reservationBrand:unique symbol;
export interface InertStoreReservation{readonly [reservationBrand]:never;}
type State={path:string;writers:Set<StoreWriterTicket>;reservations:Set<InertStoreReservation>;revision:bigint;domain:StoreAuthorityDomain|null;sealed:boolean;closed:boolean};
type Writer={state:State;live:boolean;submitted:boolean;kind:'Connection'|'Worker'};
type Reservation={state:State;owner:object;revoked:boolean;released:boolean};
const stores=new Map<string,State>(),writers=new WeakMap<object,Writer>(),reservations=new WeakMap<object,Reservation>();
const domains=new WeakMap<object,State>(),construction=Object.freeze({});
let nativeOwners=0;
export function authorityStorePath(path:string):string{
 const pinned=pinNativeRuntimePath(path);if(pinned.includes('\0')||Buffer.byteLength(pinned)>65536)throw new TypeError('Expected bounded store path');return pinned;
}
function stateFor(path:string):State{
 let state=stores.get(path);if(state===undefined){state={path,writers:new Set(),reservations:new Set(),revision:0n,domain:null,sealed:false,closed:false};stores.set(path,state);}return state;
}
function domainState(domain:StoreAuthorityDomain):State{const state=domains.get(domain);if(state===undefined)throw new TypeError('Expected private store authority domain');return state;}
export function requireStoreAuthorityPath(domain:StoreAuthorityDomain,path:string):void{const state=domainState(domain);if(state.closed||state.path!==authorityStorePath(path))throw new TypeError('Store accounting belongs to another path or a closed domain');}
function revoke(state:State):void{state.revision++;for(const ticket of state.reservations)reservations.get(ticket)!.revoked=true;}
function prune(state:State):void{if(state.domain===null&&state.writers.size===0&&stores.get(state.path)===state)stores.delete(state.path);}
function register(state:State,kind:Writer['kind']):StoreWriterTicket{
 if(state.closed)throw new Error('Store authority domain is closed');
 // Sealing stops reservations, not already-owned completion/cleanup writes.
 const ticket=Object.freeze({}) as StoreWriterTicket;writers.set(ticket,{state,live:true,submitted:false,kind});state.writers.add(ticket);revoke(state);return ticket;
}
function writer(ticket:StoreWriterTicket):Writer{const value=writers.get(ticket);if(value===undefined)throw new TypeError('Expected private store writer ticket');return value;}
/** Internal owner API. Production imports are restricted by graph coverage. */
export function registerStoreWriter(path:string,kind:Writer['kind']):StoreWriterTicket{
 if(!isMainThread)throw new TypeError('Store writer registrations belong to the main owner');
 if(kind!=='Connection'&&kind!=='Worker')throw new TypeError('Invalid store writer kind');return register(stateFor(authorityStorePath(path)),kind);
}
export function reopenStoreWriter(previous:StoreWriterTicket):StoreWriterTicket{
 const old=writer(previous);if(old.live||old.kind!=='Connection')throw new TypeError('Expected a closed connection registration');
 if(old.state.closed)throw new Error('Store authority domain is closed');return registerStoreWriter(old.state.path,'Connection');
}
export function markStoreWorkerSubmitted(ticket:StoreWriterTicket):void{const value=writer(ticket);if(!value.live||value.kind!=='Worker'||value.submitted)throw new TypeError('Invalid native writer submission');value.submitted=true;}
export function releaseStoreWriter(ticket:StoreWriterTicket,reason:'Unsubmitted'|'WorkerExited'|'ConnectionClosed'):void{
 const value=writer(ticket);if(!value.live)throw new TypeError('Store writer was already released');
 if(value.kind==='Worker'?(value.submitted?reason!=='WorkerExited':reason!=='Unsubmitted'):reason!=='ConnectionClosed'&&reason!=='Unsubmitted')throw new TypeError('Store writer release does not match owned lifetime');
 value.live=false;value.state.writers.delete(ticket);prune(value.state);
}
/** Tracks even compatibility workers so enrollment cannot cross an unverified
 * native lifetime. This counter is independent of scheduling lane capacity. */
export function beginAuthorityNativeOwner():()=>void{nativeOwners++;let ended=false;return()=>{if(ended)throw new TypeError('Native owner already joined');ended=true;nativeOwners--;};}
export function anyStoreAuthorityEnrolled():boolean{return [...stores.values()].some(s=>s.domain!==null&&!s.closed);}
export function storeAuthorityEnrolled(path:string):boolean{const state=stores.get(authorityStorePath(path));return state?.domain!==null&&state?.domain!==undefined&&!state.closed;}

/** No method on this class produces usable wire authority. Even a current inert
 * reservation remains uncertified and is never consumed by the resident/writer. */
export class StoreAuthorityDomain{
 private constructor(token:object,state:State){if(token!==construction)throw new TypeError('Expected private domain construction');domains.set(this,state);Object.freeze(this);}
 static enroll(path:string):StoreAuthorityDomain{
  if(!isMainThread)throw new TypeError('Only the main owner can enroll a store');
  const pinned=authorityStorePath(path),existing=stores.get(pinned);
  if(nativeOwners!==0||existing!==undefined&&(existing.domain!==null||existing.writers.size!==0))throw new Error('Store enrollment requires no existing native or writable owners');
  const state=stateFor(pinned),domain=new StoreAuthorityDomain(construction,state);state.domain=domain;return domain;
 }
 snapshot():Readonly<{writers:number;reservations:number;revision:bigint;sealed:boolean;closed:boolean;certified:false}>{const state=domainState(this);return Object.freeze({writers:state.writers.size,reservations:state.reservations.size,revision:state.revision,sealed:state.sealed,closed:state.closed,certified:false});}
 reserveInert(owner:object):InertStoreReservation|null{
  const state=domainState(this);if(owner===null||typeof owner!=='object'||types.isProxy(owner))throw new TypeError('Expected an original reservation owner');
  if(state.closed||state.sealed||state.writers.size!==0||state.reservations.size!==0)return null;
  const ticket=Object.freeze({}) as InertStoreReservation;reservations.set(ticket,{state,owner,revoked:false,released:false});state.reservations.add(ticket);return ticket;
 }
 assertInertCurrent(ticket:InertStoreReservation,owner:object):void{
  const state=domainState(this),entry=reservations.get(ticket);if(entry===undefined||entry.state!==state||entry.owner!==owner||entry.released||entry.revoked||state.sealed||state.closed)throw new Error('Inert store reservation is not current');
 }
 releaseInert(ticket:InertStoreReservation):void{const state=domainState(this),entry=reservations.get(ticket);if(entry===undefined||entry.state!==state||entry.released)throw new TypeError('Expected owned inert reservation');entry.released=true;state.reservations.delete(ticket);}
 seal():void{const state=domainState(this);if(state.closed)return;state.sealed=true;revoke(state);}
 closeAfterOwnersJoined():void{
  const state=domainState(this);if(state.closed)return;this.seal();
  if(state.writers.size!==0)throw new Error('Store authority ownership has not joined');
  for(const ticket of state.reservations)reservations.get(ticket)!.released=true;state.reservations.clear();state.closed=true;
  if(stores.get(state.path)===state)stores.delete(state.path);
 }
}
