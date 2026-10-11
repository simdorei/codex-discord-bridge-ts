import {types} from 'node:util';
import {invokeSynchronousVoid} from '../core/synchronous-void.ts';
import {pinOwnedDispatchMutationFence,type OwnedDispatchMutationFence} from './owned-dispatch-attempt.ts';
/** Optional owned native lifetime, distinct from all legacy synchronous hooks.
 * Receipt validation must be synchronous immediately before the actual wire.
 * Terminal close joins this capability after all resident dispatch tasks settle. */
export interface ResidentNativeDispatch extends OwnedDispatchMutationFence {
 validate(receipt:object):void;
 close():Promise<void>;
}
export function pinResidentNativeDispatch(input:ResidentNativeDispatch):ResidentNativeDispatch{
 const fence=pinOwnedDispatchMutationFence(input);
 const get=(name:string,sync:boolean):Function=>{const d=Object.getOwnPropertyDescriptor(input,name);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||types.isGeneratorFunction(d.value)||(sync&&types.isAsyncFunction(d.value)))throw new TypeError('Expected own native resident callback');return d.value;};
 const validate=get('validate',true),close=get('close',false);
 return Object.freeze({...fence,validate:(receipt:object)=>invokeSynchronousVoid(validate,input,[receipt]),close:async()=>{const result=Reflect.apply(close,input,[]);if(!types.isPromise(result))throw new TypeError('Native resident close must return a Promise');if(await result!==undefined)throw new TypeError('Native resident close must resolve void');}});
}
