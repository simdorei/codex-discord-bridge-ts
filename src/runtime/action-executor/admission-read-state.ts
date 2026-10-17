import {types} from 'node:util';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {StateAccessFacade,type IStateAccessFacade} from '../../store/state-access-facade.ts';
export type AdmissionReads=Pick<IStateAccessFacade,'getIngress'|'ingressByOrigin'|'mirroredThreadId'>;
/** Passive, installation-bound observations only. Each read is separate, joins
 * its original Promise, and grants no reservation or mutation authority. */
export function captureAdmissionReads(path:string,input:AdmissionReads=StateAccessFacade):AdmissionReads{
 requireDiscordText(path);
 const capture=<K extends keyof AdmissionReads>(key:K):AdmissionReads[K]=>{const fn=gatewayOwnField(input,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected passive admission read function');return fn as AdmissionReads[K];};
 const ingress=capture('getIngress'),origin=capture('ingressByOrigin'),mapping=capture('mirroredThreadId');
 const check=(given:string)=>{if(given!==path)throw new TypeError('Admission read is bound to another database');};
 const promise=<T>(value:Promise<T>):Promise<T>=>{if(!types.isPromise(value))throw new TypeError('Expected admission read Promise');return value;};
 return Object.freeze({
  getIngress:(given,key)=>{check(given);return promise(Reflect.apply(ingress,undefined,[given,key]));},
  ingressByOrigin:(given,event)=>{check(given);return promise(Reflect.apply(origin,undefined,[given,event]));},
  mirroredThreadId:(given,channel)=>{check(given);return promise(Reflect.apply(mapping,undefined,[given,channel]));},
 });
}
