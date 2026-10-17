import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {StoreAuthorityDomain} from '../store/store-authority-domain.ts';
import {PosixRuntimeInstance} from './runtime-instance.ts';
import type {RuntimePaths} from './runtime-paths/resolve.ts';
import {enrollLocalStoreAuthority,requireLocalStoreAuthorityPaths} from './discord-runtime/store-authority-profile.ts';
import {capturePersistentResidentBootstrapData,capturePersistentResidentPath} from './persistent-resident-bootstrap.ts';
import {preparePersistentResident} from './persistent-resident-supervisor.ts';
import type {PersistentResidentPreparation} from './persistent-resident-store-role.ts';

export interface RootBoundPersistentResidentPreparation extends PersistentResidentPreparation {
 snapshot():ReturnType<PersistentResidentPreparation['snapshot']>&Readonly<{accountingClosed:boolean}>;
}

/** Internal unstarted preparation only; not installed lifecycle composition.
 * The private attached domain bridges a specific ownership gap: preparation
 * releases its writer on actual exit even when its logical root debt survives.
 * Keep the authentic singleton unreleasable until normal close proves both.
 * Captured paths remain spelling/accounting, not physical-file certification. */
export function prepareRootBoundPersistentResident(instance:PosixRuntimeInstance,paths:Pick<RuntimePaths,'root'|'mirrorDb'>,runtimeId:string):RootBoundPersistentResidentPreparation{
 const captured=Object.freeze({root:capturePersistentResidentPath(own(paths,'root')),mirrorDb:capturePersistentResidentPath(own(paths,'mirrorDb'))});
 requireLocalStoreAuthorityPaths(captured);
 const data=capturePersistentResidentBootstrapData({version:1,kind:'persistent-resident-bootstrap',runtimeId});
 PosixRuntimeInstance.prototype.requireHeldRoot.call(instance,captured.root);
 // Enrollment and original Worker construction are synchronous. No await or
 // callback can release/swap the original root between these two boundaries.
 const domain=enrollLocalStoreAuthority(instance,captured,{kind:'StoreAuthorityAccountingOnly'});
 let prepared:PersistentResidentPreparation;
 try{prepared=preparePersistentResident(captured.mirrorDb,data.runtimeId);}
 catch(primary){
  try{StoreAuthorityDomain.prototype.closeAfterOwnersJoined.call(domain);}
  catch(cleanup){throw new AggregateError([primary,cleanup],'Persistent preparation construction cleanup debt retained',{cause:primary});}
  throw primary;
 }
 const joined=prepared.join();
 const retain=()=>StoreAuthorityDomain.prototype.seal.call(domain);
 void prepared.ready.catch(retain);
 void joined.then(()=>{if(prepared.snapshot().rootDebt)retain();},retain);
 let closing:Promise<void>|undefined;
 return Object.freeze({
  ready:prepared.ready,
  join:()=>joined,
  closeUnstarted():Promise<void>{
   if(closing!==undefined)return closing;
   const state=prepared.snapshot().state;
   // Preserve an early caller's original refusal without making that invalid
   // request permanently consume the later role-ready normal-close operation.
   if(state==='bootstrapping'||state==='quarantined')return prepared.closeUnstarted();
   closing=(async()=>{
    try{
     await prepared.closeUnstarted();await joined;
     const proof=prepared.snapshot();
     if(proof.state!=='joined'||!proof.submitted||!proof.exited||proof.registrationLive||proof.rootDebt||proof.runtimeStarted)throw new Error('Persistent preparation normal close is unconfirmed; original root retained');
     PosixRuntimeInstance.prototype.requireHeldRoot.call(instance,captured.root);
     StoreAuthorityDomain.prototype.closeAfterOwnersJoined.call(domain);
    }catch(error){retain();throw error;}
   })();void closing.catch(()=>{});return closing;
  },
  snapshot:()=>{
   const original=prepared.snapshot(),accountingClosed=StoreAuthorityDomain.prototype.snapshot.call(domain).closed;
   return Object.freeze({...original,rootDebt:original.rootDebt||!accountingClosed,accountingClosed});
  },
 });
}
