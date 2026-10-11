import {types} from 'node:util';
import type {RuntimeConfig} from '../../config/runtime.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {InteractionAccessPolicy} from '../../discord/interaction-access.ts';
import {refreshMirrorPolicyOffThread,type NativeMirrorPolicyLimits} from './native-mirror-policy.ts';
const size=Object.getOwnPropertyDescriptor(Set.prototype,'size')!.get!;
function captureIds(value:unknown):readonly bigint[]{
 if(value===null||typeof value!=='object'||types.isProxy(value)||Object.getPrototypeOf(value)!==Set.prototype)throw new TypeError('Expected owned configuration ID set');
 if(Reflect.apply(size,value,[])>4096)throw new RangeError('Static policy ID budget exceeded');
 const ids:bigint[]=[];for(const id of Set.prototype.values.call(value)){if(typeof id!=='bigint'||id<0n||id>=(1n<<64n))throw new TypeError('Expected configured u64 identity');ids.push(id);}return Object.freeze(ids);
}
/** Source interaction_policy bootstrap, after bridge initialization and before
 * gateway/intake consumers. Static sets are captured without caller iteration;
 * dynamic rooms come from the complete existing-only native policy profile.
 * No stale dynamic-ID fallback and no missing-store initialization. This does not
 * replace periodic/live legacy refresh callers or claim global DB offload. */
export async function buildRuntimeAccessPolicy(config:Pick<RuntimeConfig,'allowedChannelIds'|'allowedUserIds'|'allowAllChannels'>,database:string,limits:NativeMirrorPolicyLimits,signal?:AbortSignal):Promise<InteractionAccessPolicy>{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected startup policy abort signal');signal?.throwIfAborted();
 return refreshMirrorPolicyOffThread(captureRuntimeAccessPolicy(config),database,limits,signal);
}

/** Pure immutable initial policy, safe to capture before earlier startup awaits. */
export function captureRuntimeAccessPolicy(config:Pick<RuntimeConfig,'allowedChannelIds'|'allowedUserIds'|'allowAllChannels'>):InteractionAccessPolicy{
 const allowedChannelIds=captureIds(own(config,'allowedChannelIds')),allowedUserIds=captureIds(own(config,'allowedUserIds')),allowAllChannels=own(config,'allowAllChannels');
 if(typeof allowAllChannels!=='boolean')throw new TypeError('Expected configured channel policy flag');
 const base=new InteractionAccessPolicy({allowedChannelIds,allowedUserIds,allowAllChannels,mirroredChannelIds:[]});return base;
}
