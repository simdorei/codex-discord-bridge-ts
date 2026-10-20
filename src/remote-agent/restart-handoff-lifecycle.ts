import {types} from 'node:util';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {ownedPort,type RemoteProjectBinding} from './dispatcher-ports.ts';
import type {RemoteUtcDateTime} from './datetime.ts';
import type {RemoteDispatcherConfiguration} from './project-dispatcher.ts';
import type {SyntheticRemoteHandoffPorts} from './managed-agent.ts';
import {formatRemoteUtcDateTime} from './datetime-format.ts';
import {MAX_RESTART_HANDOFF_BYTES,type RestartHandoffBinding} from './restart-handoff-codec.ts';
import {claimPosixRestartHandoff,writePosixRestartHandoff,type RestartHandoffProtector} from './restart-handoff-persistence.ts';

/** Explicit trusted ciphertext adapter for the synthetic loopback runtime only.
 * No default path, clock, binding, protector or current-user protection claim. */
export interface PosixRuntimeRestartHandoff {
 readonly kind:'PosixCiphertextRestartHandoff';
 readonly path:string;
 readonly resumeRequested:boolean;
 readonly protector:RestartHandoffProtector;
}
function exact(value:unknown,names:readonly string[]):void{
 if(value===null||typeof value!=='object'||types.isProxy(value)||Array.isArray(value))throw new TypeError('Expected passive POSIX handoff record');
 const prototype=Object.getPrototypeOf(value);
 if((prototype!==Object.prototype&&prototype!==null)||Reflect.ownKeys(value).length!==names.length)throw new TypeError('Expected exact POSIX handoff record');
 for(const name of names){own(value,name);if(!Object.getOwnPropertyDescriptor(value,name)!.enumerable)throw new TypeError('Expected enumerable POSIX handoff field');}
}
/** Internal composition helper, not a new lifetime or persistence implementation.
 * Captures only: no clock call, filesystem operation or protection callback. */
export function capturePosixRuntimeRestartHandoff(
 input:PosixRuntimeRestartHandoff,binding:RestartHandoffBinding,nowUtc:RemoteDispatcherConfiguration['nowUtc'],
):SyntheticRemoteHandoffPorts{
 exact(input,['kind','path','resumeRequested','protector']);
 if(own(input,'kind')!=='PosixCiphertextRestartHandoff')throw new TypeError('Expected explicit POSIX ciphertext handoff');
 const path=own(input,'path'),resumeRequested=own(input,'resumeRequested'),rawProtector=own(input,'protector');
 if(typeof path!=='string'||path.length>MAX_RESTART_HANDOFF_BYTES||!path.startsWith('/')||path.includes('\0')||/[\uD800-\uDFFF]/u.test(path)||Buffer.byteLength(path)>MAX_RESTART_HANDOFF_BYTES)throw new TypeError('Expected absolute POSIX handoff path');
 if(typeof resumeRequested!=='boolean')throw new TypeError('Expected explicit resume choice');
 exact(rawProtector,['protect','unprotect']);
 const protector=Object.freeze({protect:ownedPort<RestartHandoffProtector['protect']>(rawProtector,'protect'),unprotect:ownedPort<RestartHandoffProtector['unprotect']>(rawProtector,'unprotect')});
 // Requiring the supplied spelling avoids using a raw fingerprint for a silently
 // normalized socket target. This is WHATWG canonical spelling, not a claim of
 // Rust URL serialization equivalence for every accepted URL component.
 const bridgeUrl=own(binding,'bridgeUrl'),deviceId=own(binding,'deviceId');
 if(typeof bridgeUrl!=='string'||typeof deviceId!=='string')throw new TypeError('Expected captured handoff binding');
 const url=new URL(bridgeUrl);
 if(url.href!==bridgeUrl||url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.port===''||url.port==='0'||url.username!==''||url.password!==''||bridgeUrl.includes('#'))throw new TypeError('POSIX handoff requires canonical loopback URL spelling');
 const capturedBinding=Object.freeze({bridgeUrl,deviceId});
 // Capture the same clock function used by the owning dispatcher. No separate
 // caller-supplied handoff clock or binding is accepted in the option record.
 const clock=ownedPort<RemoteDispatcherConfiguration['nowUtc']>({nowUtc},'nowUtc');
 return Object.freeze({kind:'SyntheticProtectedBindingPorts' as const,
  restore:async()=>{
   if(!resumeRequested)return Object.freeze([]);
   const raw=Reflect.apply(clock,undefined,[]),now=Object.freeze({seconds:own(raw,'seconds') as bigint,nanosecond:own(raw,'nanosecond') as bigint});
   formatRemoteUtcDateTime(now);
   // Cancellation is checked by the existing managed owner only after actual
   // claim/unprotect/canonicalize/removal settles. No abort race releases it.
   return claimPosixRestartHandoff(true,path,capturedBinding,now,protector);
  },
  protect:async(bindings:readonly RemoteProjectBinding[],now:RemoteUtcDateTime)=>{
   // The owner has already joined project cleanup and filtered expiry using
   // this exact timestamp. Never resample the clock at the writer boundary.
   const written=await writePosixRestartHandoff(path,bindings,capturedBinding,now,protector);
   if(typeof written!=='boolean')throw new TypeError('Invalid POSIX handoff completion');
   return written;
  },
 });
}
