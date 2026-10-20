import {types} from 'node:util';
import {requireDiscordText} from '../../discord/text.ts';
import type {IStateAccessFacade} from '../../store/state-access-facade.ts';
import {NativeControlEvidenceReader} from './control-evidence-native.ts';
type Reads=Pick<IStateAccessFacade,'hasObservedCompletion'|'mirroredThreadId'>;
/** Original per-call ordering is kept; this is not one cross-query snapshot. */
export function createNativeControlReads(path:string,mapping:Reads['mirroredThreadId']):Reads{
 requireDiscordText(path);if(typeof mapping!=='function'||types.isProxy(mapping)||types.isGeneratorFunction(mapping))throw new TypeError('Expected native mapping read');const owner=new NativeControlEvidenceReader(path),check=(p:string)=>{if(p!==path)throw new TypeError('Control read is bound to another database');};
 return Object.freeze({hasObservedCompletion:(p,thread,turn)=>{check(p);return owner.observed(thread,turn);},mirroredThreadId:(p,channel)=>{check(p);const result=Reflect.apply(mapping,undefined,[p,channel]);if(!types.isPromise(result))throw new TypeError('Expected native mapping Promise');return result;}});
}
