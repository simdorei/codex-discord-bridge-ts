import {types} from 'node:util';
/** Resident-owned read capability. A proof remains scoped to the original native
 * stream and must not clear a later gap after its asynchronous database read. */
export interface ResidentNativeObservation {
 verified(owner:string,generation:bigint,through:bigint):Promise<boolean>;
 discoverGap?(owner:string,generation:bigint,upper:bigint):Promise<void>;
 recordGap?(owner:string,generation:bigint):Promise<void>;
 close():Promise<void>;
}
export function pinResidentNativeObservation(input:ResidentNativeObservation):ResidentNativeObservation {
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected native observation capability');
 const own=(name:string):Function=>{const d=Object.getOwnPropertyDescriptor(input,name);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='function'||types.isProxy(d.value)||types.isGeneratorFunction(d.value))throw new TypeError('Expected own native observation callback');return d.value;};
 const verified=own('verified'),close=own('close');
 const hasDiscover=Object.hasOwn(input,'discoverGap'),hasRecord=Object.hasOwn(input,'recordGap');if(hasDiscover!==hasRecord)throw new TypeError('Native gap callbacks must be paired');
 const discover=hasDiscover?own('discoverGap'):null,record=hasRecord?own('recordGap'):null;
 const invoke=async(fn:Function,args:unknown[])=>{const p=Reflect.apply(fn,input,args);if(!types.isPromise(p))throw new TypeError('Native observation callback must return a Promise');return await p;};
 const gap=discover===null?{}:{discoverGap:async(owner:string,generation:bigint,upper:bigint)=>{if(await invoke(discover,[owner,generation,upper])!==undefined)throw new TypeError('Native gap discovery must resolve void');},recordGap:async(owner:string,generation:bigint)=>{if(await invoke(record!,[owner,generation])!==undefined)throw new TypeError('Native gap record must resolve void');}};
 return Object.freeze({...gap,verified:async(owner:string,generation:bigint,through:bigint)=>{const result=await invoke(verified,[owner,generation,through]);if(typeof result!=='boolean')throw new TypeError('Expected native observation boolean');return result;},close:async()=>{if(await invoke(close,[])!==undefined)throw new TypeError('Native observation close must resolve void');}});
}
