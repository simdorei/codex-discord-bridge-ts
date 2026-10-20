import {types} from 'node:util';
const check=AbortSignal.prototype.throwIfAborted,prototype=AbortSignal.prototype;
/** Native read boundaries accept an authentic standard signal with no active
 * public overrides. Node's AbortSignal.any reads public aborted/reason fields;
 * validate passively and invoke the intrinsic before composing or arming timers. */
export function checkRemoteReadCancellation(value:AbortSignal|undefined):void{
 if(value===undefined)return;
 if(value===null||typeof value!=='object'||types.isProxy(value)||Object.getPrototypeOf(value)!==prototype)throw new TypeError('Expected passive native read abort signal');
 for(const key of Reflect.ownKeys(value)){const field=Object.getOwnPropertyDescriptor(value,key)!;if(!Object.hasOwn(field,'value'))throw new TypeError('Native read abort signal accessors are not supported');}
 for(const key of ['aborted','reason','throwIfAborted','addEventListener','removeEventListener'])if(Object.hasOwn(value,key))throw new TypeError('Native read abort signal overrides are not supported');
 Reflect.apply(check,value,[]);
}
export function captureRemoteReadCancellation(value:AbortSignal|undefined):AbortSignal|undefined{checkRemoteReadCancellation(value);return value===undefined?undefined:AbortSignal.any([value]);}
