import {types} from 'node:util';
import {gatewayOwnField} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {IStateAccessFacade} from '../store/state-access-facade.ts';
type CompletedRead=Pick<IStateAccessFacade,'completedAppServerForkTargetForSource'>;
/** Capture the passive port once; each hop still performs a fresh original read. */
export function captureCompletedForkRead(path:string,state:CompletedRead):(source:string)=>Promise<string|null>{
 requireDiscordText(path);const read=gatewayOwnField(state,'completedAppServerForkTargetForSource');
 if(typeof read!=='function'||types.isProxy(read)||types.isGeneratorFunction(read))throw new TypeError('Expected passive completed-fork read function');
 return source=>{
  requireDiscordText(source);const pending=Reflect.apply(read,undefined,[path,source]);
  if(!types.isPromise(pending))throw new TypeError('Expected completed-fork read Promise');
  return Promise.prototype.then.call(pending,(target:unknown)=>{if(target!==null)requireDiscordText(target);return target as string|null;}) as Promise<string|null>;
 };
}
