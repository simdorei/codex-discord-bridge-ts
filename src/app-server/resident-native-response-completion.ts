import {types} from 'node:util';
import type {DurableResponseClaim,DurableResponseCompletion} from './response-attempt.ts';
/** Post-effect persistence only. Capture is synchronous private bookkeeping, not
 * durable admission or permission to write. The original synchronous response
 * fence still admits the actual write. Completion joins its native worker. */
export interface ResidentNativeResponseCompletion {
 captureResponse(claim:DurableResponseClaim):object;
 finishResponse(receipt:object,outcome:DurableResponseCompletion['outcome'],signal?:AbortSignal):Promise<void>;
 close():Promise<void>;
}
export function pinResidentNativeResponseCompletion(input:ResidentNativeResponseCompletion):ResidentNativeResponseCompletion{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected owned native response completion');
 const method=(name:string,sync=false):Function=>{const d=Object.getOwnPropertyDescriptor(input,name);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||types.isGeneratorFunction(d.value)||(sync&&types.isAsyncFunction(d.value)))throw new TypeError('Expected own native response callback');return d.value;};
 const capture=method('captureResponse',true),finish=method('finishResponse'),close=method('close');
 const invoke=async(fn:Function,args:unknown[])=>{const value=Reflect.apply(fn,input,args);if(!types.isPromise(value))throw new TypeError('Native response completion must return a Promise');if(await value!==undefined)throw new TypeError('Native response completion must resolve void');};
 return Object.freeze({captureResponse:(claim:DurableResponseClaim)=>{const value=Reflect.apply(capture,input,[claim]);if(types.isPromise(value))void Promise.prototype.then.call(value,undefined,()=>undefined);if(value===null||typeof value!=='object'||types.isProxy(value)||types.isPromise(value)||!Object.isFrozen(value))throw new TypeError('Expected immutable native response receipt');return value;},finishResponse:(receipt:object,outcome:DurableResponseCompletion['outcome'],signal?:AbortSignal)=>invoke(finish,[receipt,outcome,signal]),close:()=>invoke(close,[])});
}
