import {jsonError,object} from './request-input.ts';
import type {Decoder} from './request-input.ts';

type Shape = Readonly<Record<string,Decoder<unknown>>>;
type Decoded<S extends Shape> = {readonly [K in keyof S]:ReturnType<S[K]>};

/** Internal schema readers only receive fresh bounded JSON, never arbitrary
 * caller objects. Nested structs deny even a stray kind field. */
export function outputRecord<const S extends Shape>(shape:S,optional:readonly (keyof S)[]=[]):Decoder<Decoded<S>>{
 return value=>{
  const input=object(value),result:Record<string,unknown>=Object.create(null);
  for(const key of Object.keys(input))if(!Object.hasOwn(shape,key))jsonError('unknown output field');
  for(const key of Object.keys(shape)){
   if(!Object.hasOwn(input,key)){
    if(!optional.includes(key))jsonError(`missing ${key}`);
    result[key]=null;
   }else result[key]=shape[key]!(input[key]);
  }
  return Object.freeze(result) as Decoded<S>;
 };
}
export function outputArray<T>(decode:Decoder<T>):Decoder<readonly T[]>{
 return value=>{if(!Array.isArray(value))return jsonError('expected output array');return Object.freeze(value.map(decode));};
}
