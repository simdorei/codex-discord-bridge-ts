import type {AdmissionReads} from './admission-read-state.ts';
import {NativeBridgeStateOwner,type BridgeSelectionSnapshot} from '../bridge-state-native.ts';
import {NativeRepairClaimOwner,type NativeRepairClaim} from '../writer-recovery/native-repair-owner.ts';
import {withStopOrigin} from '../../app-server/dispatch-origin.ts';
import {stopOriginForIngress} from '../../store/stop-revision-read.ts';
import type {DatabaseSync} from 'node:sqlite';
import {StateAccessFacade as state} from '../../store/state-access-facade.ts';
import type {RecoveryClaim} from '../../store/ingress-recovery-custody.ts';
import {BridgeState} from '../bridge-state.ts';
import {createRuntimeFenceErrors} from '../fence-errors.ts';
import {loadLifecycleAdmission,type LifecycleActor} from './lifecycle-admission.ts';
import {validateSelectedSettingsSnapshot,type FrozenSettingsBinding} from './settings-snapshot.ts';
import {storeActionCheck} from './errors.ts';
const TOKEN=Symbol('admitted recovery guard');
/** One-use server-stored recovery custody; checks are synchronous at actual
 * writer/cancellation boundaries. Current-schema reads do not initialize or
 * migrate a database in a transport callback. Repair claim writes are native;
 * the final borrowed checks intentionally remain synchronous. */
export class RecoveryGuard{
 readonly #nativeClaim:Readonly<{owner:NativeRepairClaimOwner;claim:NativeRepairClaim}>|undefined;readonly #origin:unknown;readonly #path:string;readonly #binding:FrozenSettingsBinding;readonly #channel:bigint;readonly #claim:RecoveryClaim|null;readonly #selected:()=>void;readonly #errors:ReturnType<typeof createRuntimeFenceErrors>;
 constructor(token:typeof TOKEN,path:string,binding:FrozenSettingsBinding,channel:bigint,claim:RecoveryClaim|null,origin:unknown,bridge:BridgeState,render:(error:unknown)=>string,selectedCheck?:()=>void,nativeClaim?:Readonly<{owner:NativeRepairClaimOwner;claim:NativeRepairClaim}>){
  if(token!==TOKEN)throw new TypeError('Recovery guard requires admitted custody');this.#nativeClaim=nativeClaim;this.#origin=origin;this.#path=path;this.#binding=binding;this.#channel=channel;this.#claim=claim;this.#errors=createRuntimeFenceErrors(render);this.#selected=storeActionCheck(selectedCheck??(()=>validateSelectedSettingsSnapshot(binding,bridge)),render);Object.freeze(this);
 }
 runWithOriginalStopOrigin<T>(work:()=>Promise<T>):Promise<T>{return withStopOrigin(this.#origin,work);}
 get target():string{return this.#binding.target;}
 checkIn(db:DatabaseSync):undefined{this.#selected();if(this.#nativeClaim!==undefined)NativeRepairClaimOwner.prototype.checkIn.call(this.#nativeClaim.owner,this.#nativeClaim.claim,db);else state.validateRecoveryEffectIn(db,this.#binding,this.#channel,this.#claim);return undefined;}
 check():void{const read=state.openCheckedRead(this.#path);try{this.checkIn(read.connection());read.finish();}finally{read.close();}}
 /** Rejection flag is owned by this exact callback, never supplied by RPC data. */
 rpcCheck():Readonly<{check:()=>void;rejected:()=>boolean}>{
  let rejected=false;return Object.freeze({check:()=>{try{this.check();}catch(error){rejected=true;this.#errors.fail('InvalidReply',error);}},rejected:()=>rejected});
 }
}
Object.freeze(RecoveryGuard.prototype);
export async function claimAdmittedRecovery(path:string,bridge:BridgeState,actor:LifecycleActor,kind:'Recover'|'Repair',reference:string|null,key:string,render:(error:unknown)=>string,signal?:AbortSignal,nativeBridge?:NativeBridgeStateOwner,admission?:AdmissionReads,repairOwner?:NativeRepairClaimOwner):Promise<RecoveryGuard>{
 const {record,binding}=await loadLifecycleAdmission(path,actor,kind,reference,key,signal,admission);
 let selection:BridgeSelectionSnapshot|null=null;
 if(nativeBridge!==undefined&&binding.route==='Selected')selection=await NativeBridgeStateOwner.prototype.captureSelected.call(nativeBridge,signal);
 signal?.throwIfAborted();const beforeCheck=selection===null?undefined:()=>NativeBridgeStateOwner.prototype.validateSelected.call(nativeBridge!,selection!,binding.target);
 const before=new RecoveryGuard(TOKEN,path,binding,record.channelId,null,stopOriginForIngress(record)??null,bridge,render,beforeCheck);if(kind!=='Repair')before.check();signal?.throwIfAborted();
 let claim:RecoveryClaim|null=null,nativeClaim:Readonly<{owner:NativeRepairClaimOwner;claim:NativeRepairClaim}>|undefined;
 if(kind==='Repair'){
  const owner=repairOwner??new NativeRepairClaimOwner(path,bridge,nativeBridge);NativeRepairClaimOwner.prototype.assertOwner.call(owner,path,bridge,nativeBridge);
  nativeClaim=Object.freeze({owner,claim:await NativeRepairClaimOwner.prototype.claim.call(owner,record,selection,signal)});
 }else claim=await state.claimIngressRecovery(path,record);
 // Keep the first authentic epoch across the new native await. Never recapture.
 const guard=new RecoveryGuard(TOKEN,path,binding,record.channelId,claim,stopOriginForIngress(record)??null,bridge,render,beforeCheck,nativeClaim);guard.check();signal?.throwIfAborted();return guard;
}
