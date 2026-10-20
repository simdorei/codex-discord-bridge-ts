import {types} from 'node:util';
import type {DeadGenerationWork} from './dead-generation-work.ts';
/** A separate asynchronous lifetime, never a Promise in the legacy synchronous
 * persistence hook. Capture resolves only after an exact commit ACK and native exit. */
export interface ResidentNativeDeadGeneration {
 capture(instanceId:string,work:DeadGenerationWork,signal?:AbortSignal):Promise<void>;
 close():Promise<void>;
}
export function pinResidentNativeDeadGeneration(input:ResidentNativeDeadGeneration):ResidentNativeDeadGeneration {
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected native dead-generation owner');
 const get=(name:string):Function=>{const d=Object.getOwnPropertyDescriptor(input,name);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||types.isGeneratorFunction(d.value))throw new TypeError('Expected own native dead-generation callback');return d.value;};
 const capture=get('capture'),close=get('close');
 const call=async(fn:Function,args:unknown[])=>{const result=Reflect.apply(fn,input,args);if(!types.isPromise(result))throw new TypeError('Native dead-generation operation must return a Promise');if(await result!==undefined)throw new TypeError('Native dead-generation operation must resolve void');};
 return Object.freeze({capture:(id:string,work:DeadGenerationWork,signal?:AbortSignal)=>call(capture,[id,work,signal]),close:()=>call(close,[])});
}
