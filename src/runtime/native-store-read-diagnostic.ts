import {types} from 'node:util';
import {StoreIntegrityError, UnsupportedVersionError} from '../store/schema-assembly.ts';
import {InvalidQueueStateError, StoreJsonError} from '../store/queue-read.ts';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';

/** Classification only. Never carry SQL, paths, row values, messages or stacks.
 * This value is diagnostic, not admission, exit, response or release evidence. */
export type NativeStoreReadLeaf = Readonly<{kind:'Integrity'|'InvalidQueueState'|'Json'}>
  | Readonly<{kind:'UnsupportedVersion';found:bigint;supported:bigint}>
  | Readonly<{kind:'Database';errcode:number|null}>;
export type NativeStoreReadDiagnostic = NativeStoreReadLeaf
  | Readonly<{kind:'ScopeCleanup';errors:readonly NativeStoreReadLeaf[]}>;
export const NATIVE_STORE_READ_DIAGNOSTIC_BYTES=512;
function data(value:unknown,key:string):unknown {
  const d=Object.getOwnPropertyDescriptor(value as object,key);
  if(d===undefined||!Object.hasOwn(d,'value'))throw new TypeError('Expected diagnostic data');
  return d.value;
}
function exact(value:unknown,keys:readonly string[]):void {
  if(value===null||typeof value!=='object'||types.isProxy(value))throw new TypeError('Expected diagnostic record');
  const p=Object.getPrototypeOf(value);if(p!==Object.prototype&&p!==null)throw new TypeError('Invalid diagnostic prototype');
  const own=Reflect.ownKeys(value);if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)))throw new TypeError('Invalid diagnostic fields');
  for(const k of keys){const d=Object.getOwnPropertyDescriptor(value,k)!;if(!d.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Expected diagnostic own data');}
}
function i64(value:unknown):bigint {if(typeof value!=='bigint'||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError('Expected diagnostic i64');return value;}
function code(value:unknown):number|null {if(value===null)return null;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0||value>2147483647||Object.is(value,-0))throw new TypeError('Invalid SQLite diagnostic code');return value;}
function leaf(value:unknown):NativeStoreReadLeaf {
  if(value===null||typeof value!=='object'||types.isProxy(value))throw new TypeError('Expected diagnostic leaf');
  const kind=data(value,'kind');
  if(kind==='Integrity'||kind==='InvalidQueueState'||kind==='Json'){exact(value,['kind']);return Object.freeze({kind});}
  if(kind==='UnsupportedVersion'){exact(value,['kind','found','supported']);return Object.freeze({kind,found:i64(data(value,'found')),supported:i64(data(value,'supported'))});}
  if(kind==='Database'){exact(value,['kind','errcode']);return Object.freeze({kind,errcode:code(data(value,'errcode'))});}
  throw new TypeError('Unknown store diagnostic');
}
function children(value:unknown):readonly unknown[] {
  if(!Array.isArray(value)||types.isProxy(value)||Object.getPrototypeOf(value)!==Array.prototype)throw new TypeError('Expected diagnostic children');
  const length=data(value,'length');if(length!==2)throw new TypeError('Invalid diagnostic child count');
  const keys=Reflect.ownKeys(value);if(keys.length!==length+1||keys.some(k=>k!=='length'&&k!=='0'&&(length!==2||k!=='1')))throw new TypeError('Invalid diagnostic child fields');
  const result:unknown[]=[];for(let i=0;i<length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))throw new TypeError('Expected dense diagnostic children');result.push(d.value);}return result;
}
/** A pure decoder creates no provenance. Only the original joined adapter may
 * associate this data with its own outer error in its private WeakMap. */
export function captureNativeStoreReadDiagnostic(value:unknown):NativeStoreReadDiagnostic {
  if(value===null||typeof value!=='object'||types.isProxy(value))throw new TypeError('Expected store diagnostic');
  let result:NativeStoreReadDiagnostic;
  if(data(value,'kind')==='ScopeCleanup'){exact(value,['kind','errors']);result=Object.freeze({kind:'ScopeCleanup',errors:Object.freeze(children(data(value,'errors')).map(leaf))});}
  else result=leaf(value);
  if(boundedSerdeByteCount(result,NATIVE_STORE_READ_DIAGNOSTIC_BYTES)===null)throw new TypeError('Store diagnostic exceeds boundary');return result;
}
/** Validate an entire negative reply against this adapter's captured request.
 * It remains data; this function cannot mark an error as actually joined. */
export function captureNativeStoreReadFailure(value:unknown,binding:Readonly<Record<string,string|bigint|null>>):NativeStoreReadDiagnostic {
  const keys=Object.keys(binding);exact(value,[...keys,'ok','storeDiagnostic']);
  if(data(value,'ok')!==false||keys.some(k=>data(value,k)!==binding[k]))throw new TypeError('Store diagnostic differs from original read');
  return captureNativeStoreReadDiagnostic(data(value,'storeDiagnostic'));
}
function projectLeaf(error:unknown):NativeStoreReadLeaf|null {
  if(error===null||typeof error!=='object'||types.isProxy(error)||!types.isNativeError(error))return null;
  const p=Object.getPrototypeOf(error);
  if(p===StoreIntegrityError.prototype)return Object.freeze({kind:'Integrity'});
  if(p===InvalidQueueStateError.prototype)return Object.freeze({kind:'InvalidQueueState'});
  if(p===StoreJsonError.prototype)return Object.freeze({kind:'Json'});
  if(p===UnsupportedVersionError.prototype)return Object.freeze({kind:'UnsupportedVersion',found:i64(data(error,'found')),supported:i64(data(error,'supported'))});
  if(p===Error.prototype&&data(error,'code')==='ERR_SQLITE_ERROR'){
    const d=Object.getOwnPropertyDescriptor(error,'errcode');
    if(d!==undefined&&!Object.hasOwn(d,'value'))return null;
    return Object.freeze({kind:'Database',errcode:d===undefined?null:code(d.value)});
  }
  return null;
}
/** Called only in the fixed native read's catch. Unknown exceptions and any
 * unknown aggregate child reject the whole projection; nothing is guessed. */
export function projectNativeStoreReadDiagnostic(error:unknown):NativeStoreReadDiagnostic|null {
  try{
    const single=projectLeaf(error);if(single!==null)return single;
    if(error===null||typeof error!=='object'||types.isProxy(error)||Object.getPrototypeOf(error)!==AggregateError.prototype||!types.isNativeError(error))return null;
    const projected=children(data(error,'errors')).map(projectLeaf);if(projected.some(v=>v===null))return null;
    return captureNativeStoreReadDiagnostic({kind:'ScopeCleanup',errors:projected});
  }catch{return null;}
}
function describe(value:NativeStoreReadDiagnostic):string {
  switch(value.kind){
    case 'Integrity':return 'SQLite integrity check failed';
    case 'InvalidQueueState':return 'invalid durable queue state';
    case 'Json':return 'stored JSON decoding failed';
    case 'UnsupportedVersion':return `store schema version ${value.found} differs from supported version ${value.supported}`;
    case 'Database':return value.errcode===null?'SQLite store error':`SQLite store error (code ${value.errcode})`;
    case 'ScopeCleanup':return `Store scope cleanup failed: ${value.errors.map(describe).join('; ')}`;
  }
}
/** Safe reconstructed classification, with no operational authority or original
 * JS object-identity claim. Raw native/source error text is intentionally absent. */
export class NativeStoreReadError extends Error {
  readonly diagnostic:NativeStoreReadDiagnostic;
  constructor(input:NativeStoreReadDiagnostic){const diagnostic=captureNativeStoreReadDiagnostic(input);super(describe(diagnostic));this.name='NativeStoreReadError';this.diagnostic=diagnostic;Object.freeze(this);}
}
