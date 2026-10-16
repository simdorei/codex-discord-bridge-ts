import {types} from 'node:util';
import {cloneIdleReleaseToken,type IdleReleaseToken} from './idle-release-journal.ts';
/** Native transaction returns only after actual join; not a legacy sync journal. */
export interface ResidentNativeIdle {
 before(owner:string,generation:bigint,thread:string):Promise<IdleReleaseToken|null>;
 transition(token:IdleReleaseToken,state:string,detail:string):Promise<IdleReleaseToken>;
 /** Explicit post-exit persistence capability; the owning lifecycle proves exit. */
 settleExitedOwner?(owner:string,generation:bigint):Promise<void>;
 close():Promise<void>;
}
export function pinResidentNativeIdle(input:ResidentNativeIdle):ResidentNativeIdle{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected native idle capability');
 const get=(name:string):Function=>{const d=Object.getOwnPropertyDescriptor(input,name);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||types.isGeneratorFunction(d.value))throw new TypeError('Expected own native idle callback');return d.value;};
 const before=get('before'),transition=get('transition'),close=get('close'),settle=Object.getOwnPropertyDescriptor(input,'settleExitedOwner')===undefined?undefined:get('settleExitedOwner');
 const invoke=async(fn:Function,args:unknown[])=>{const p=Reflect.apply(fn,input,args);if(!types.isPromise(p))throw new TypeError('Native idle callback must return a Promise');return await p;};
 return Object.freeze({...(settle===undefined?{}:{settleExitedOwner:async(owner:string,generation:bigint)=>{if(await invoke(settle,[owner,generation])!==undefined)throw new TypeError('Native idle exit settlement must resolve void');}}),before:async(owner:string,generation:bigint,thread:string)=>{const value=await invoke(before,[owner,generation,thread]);return value===null?null:cloneIdleReleaseToken(value);},transition:async(token:IdleReleaseToken,state:string,detail:string)=>cloneIdleReleaseToken(await invoke(transition,[cloneIdleReleaseToken(token),state,detail])),close:async()=>{if(await invoke(close,[])!==undefined)throw new TypeError('Native idle close must resolve void');}});
}
