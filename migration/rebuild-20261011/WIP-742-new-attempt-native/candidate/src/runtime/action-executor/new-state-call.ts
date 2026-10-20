import {types} from 'node:util';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
/** Capture a declared state function without executing accessors or proxy traps. */
export function newStateFunction<P,K extends keyof P & string>(port:P,key:K):P[K] {
 const fn=gatewayOwnField(port,key);if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned new-thread state function');return fn as P[K];
}
export function newStatePromise<T>(value:Promise<T>):Promise<T> {
 if(!types.isPromise(value))throw new TypeError('Expected native new-thread state Promise');return value;
}
