import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {StartupIngressRecoveryLimits} from '../../store/startup-ingress-recovery.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
export class RuntimeIngressRecoveryError extends Error{
 constructor(detail:string){super('Runtime ingress recovery failed: '+detail);this.name='RuntimeIngressRecoveryError';}
}
export class RuntimeIngressRecoveryUnconfirmed extends Error{
 readonly path:string;
 constructor(path:string,cause:unknown){super('Startup ingress recovery outcome is unconfirmed; keep dispatch stopped and inspect saved ingress state',{cause});this.name='RuntimeIngressRecoveryUnconfirmed';this.path=path;}
}
const slot=new OwnedWorkerSlot('Control');
/** Under caller-owned exclusive startup guard, after resident startup but before
 * intake. Bounds and runtime identity are captured before worker submission.
 * Submitted cancellation/commit uncertainty joins exit and never retries. */
export async function recoverRuntimeIngressOffThread(path:string,runtime:string,now:number,limits:StartupIngressRecoveryLimits,timeoutMs=10000,signal?:AbortSignal):Promise<number>{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected startup abort signal');signal?.throwIfAborted();
 requireDiscordText(path);if(path.includes('\0')||path.length>32768||Buffer.byteLength(path)>32768)throw new RangeError('Invalid ingress recovery path');const pinned=pinNativeRuntimePath(path);if(pinned.length>32768||Buffer.byteLength(pinned)>32768)throw new RangeError('Invalid ingress recovery path');
 requireDiscordText(runtime);if(runtime.includes('\0')||Buffer.byteLength(runtime)>4096||!Number.isFinite(now)||now<0)throw new RangeError('Invalid startup recovery identity or timestamp');
 const maxRows=own(limits,'maxRows'),maxBytes=own(limits,'maxBytes');
 if(typeof maxRows!=='number'||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)throw new RangeError('Invalid ingress recovery resource limits');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000)throw new RangeError('Invalid ingress recovery deadline');
 if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./ingress-recovery-worker.ts',import.meta.url),{path:pinned,runtime,now,limits:{maxRows,maxBytes}},timeoutMs,signal),joined=slot.join(),submitted=slot.busy;let response:unknown;
 try{try{response=await pending;}finally{await joined;}}catch(error){if(!submitted)throw error;throw new RuntimeIngressRecoveryUnconfirmed(pinned,error);}
 if(signal?.aborted)throw new RuntimeIngressRecoveryUnconfirmed(pinned,signal.reason);
 if(own(response,'ok')===true){
  const result=own(response,'result');if(typeof result==='number'&&Number.isSafeInteger(result)&&result>=0&&result<=maxRows)return result;
 }else{
  const detail=own(response,'detail');if(typeof detail==='string'&&own(response,'uncertain')===false)throw new RuntimeIngressRecoveryError(detail);
 }
 throw new RuntimeIngressRecoveryUnconfirmed(pinned,response);
}
