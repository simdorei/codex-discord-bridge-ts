import {DatabaseSync,type DatabaseSyncOptions} from 'node:sqlite';
import {isMainThread} from 'node:worker_threads';
import {authorityStorePath,registerStoreWriter,reopenStoreWriter,releaseStoreWriter,storeAuthorityEnrolled,type StoreWriterTicket} from './store-authority-domain.ts';
import {requireWorkerStoreOpen,workerStoreAccountingActive} from '../runtime/store-worker-authority.ts';

const bindings=new WeakMap<DatabaseSync,string>(),construction=Object.freeze({});
let workerConnections=0;
/** Reused native operations may acknowledge only after closing every writable
 * handle. The main owner's writer tickets still release on actual native exit. */
export function workerStoreConnectionsOpen():number{return workerConnections;}
/** Central lifetime ownership preserves native DatabaseSync brands/methods.
 * Raw prototype open/close/dispose bypasses are forbidden by graph coverage.
 * No statement/transaction outcome releases a still-open handle. */
class AuthorityConnection extends DatabaseSync{
 readonly #path:string;readonly #originalPath:string;readonly #relativeNative:boolean;#ticket:StoreWriterTicket|null;#released=false;#workerCounted=false;
 constructor(token:object,path:string,nativePath:string,options:DatabaseSyncOptions){
  if(token!==construction)throw new TypeError('Expected private authority connection construction');
  const pinned=authorityStorePath(path);requireWorkerStoreOpen(pinned);
  const ticket=isMainThread?registerStoreWriter(pinned,'Connection'):null;
  try{super(nativePath,options);}catch(error){if(ticket!==null)releaseStoreWriter(ticket,'Unsubmitted');throw error;}
  this.#path=pinned;this.#originalPath=path;this.#relativeNative=nativePath===path;this.#ticket=ticket;bindings.set(this,pinned);
  if(!isMainThread){workerConnections++;this.#workerCounted=true;}
  // Own immutable lifecycle methods prevent accidental per-handle shadowing.
  Object.defineProperties(this,{close:{value:AuthorityConnection.prototype.close},open:{value:AuthorityConnection.prototype.open},[Symbol.dispose]:{value:AuthorityConnection.prototype[Symbol.dispose]}});
 }
 override close():void{
  try{super.close();}finally{this.#releaseIfClosed();}
 }
 override [Symbol.dispose]():void{if(this.isOpen)this.close();else this.#releaseIfClosed();}
 override open():void{
  if(this.isOpen){super.open();return;}
  if(this.#relativeNative&&authorityStorePath(this.#originalPath)!==this.#path)throw new TypeError('Reopen changed the original store path binding');
  requireWorkerStoreOpen(this.#path);
  const ticket=this.#ticket===null?null:reopenStoreWriter(this.#ticket);this.#ticket=ticket;this.#released=false;
  try{super.open();if(!isMainThread&&this.isOpen&&!this.#workerCounted){workerConnections++;this.#workerCounted=true;}}finally{this.#releaseIfClosed();}
 }
 #releaseIfClosed():void{if(!this.isOpen&&!this.#released){this.#released=true;if(this.#workerCounted){workerConnections--;this.#workerCounted=false;}if(this.#ticket!==null)releaseStoreWriter(this.#ticket,'ConnectionClosed');}}
}
/** Used only by the two reviewed writable factories. The supplied options never
 * disable opening; a handle remains registered until confirmed native close. */
export function openAuthorityConnection(path:string,nativePath:string,options:DatabaseSyncOptions):DatabaseSync{
 if(options.open===false||options.readOnly===true)throw new TypeError('Expected an immediately opened writable connection');return new AuthorityConnection(construction,path,nativePath,options);
}
/** Borrowed initialization must not smuggle an unregistered/foreign handle into
 * an enrolled path, including while backup/migration is suspended at await. */
export function requireAuthorityInitialization(db:DatabaseSync,path:string):void{
 const pinned=authorityStorePath(path),original=bindings.get(db);if(storeAuthorityEnrolled(pinned)||original!==undefined&&storeAuthorityEnrolled(original)||workerStoreAccountingActive()){
  requireWorkerStoreOpen(pinned);if(bindings.get(db)!==pinned||!db.isOpen)throw new TypeError('Enrolled initialization requires the original branded store connection');
 }
}
