import {types} from 'node:util';
import {requireDiscordText} from '../../discord/text.ts';
export type RemoteFileFailureKind='UnsafePath'|'UnsafePattern'|'Size'|'Encoding'|'Conflict'|'Limit'|'Io';
export interface RemoteFileFailureDetails{readonly kind:RemoteFileFailureKind;readonly message:string;}
const failures=new WeakMap<object,RemoteFileFailureDetails>();
/** Exact typed provenance only; unlike the rendering fallback below this never
 * classifies an arbitrary exception as an owned file failure. */
export function registeredRemoteFileFailure(value:unknown):RemoteFileFailureDetails|null{return value!==null&&typeof value==='object'?failures.get(value)??null:null;}
function bounded(value:unknown):asserts value is string{requireDiscordText(value);if(value.length>65536||Buffer.byteLength(value)>65536)throw new RangeError('Remote file diagnostic exceeds byte limit');}
/** A captured diagnostic, not filesystem authority. Rendering must go through
 * the central redacting boundary. Mutable Error fields are never read there. */
export class RemoteFileFailure extends Error{
 readonly kind:RemoteFileFailureKind;readonly value:string;readonly reason:string;
 constructor(kind:RemoteFileFailureKind,value:string,reason:string){
  if(!['UnsafePath','UnsafePattern','Size','Encoding','Conflict','Limit','Io'].includes(kind))throw new TypeError('Unknown remote file failure');
  bounded(value);bounded(reason);const message=kind==='Io'?reason:`${value}: ${reason}`;bounded(message);super(message);
  this.name='RemoteFileFailure';this.kind=kind;this.value=value;this.reason=reason;failures.set(this,Object.freeze({kind,message}));
 }
}
/** No coercion, proxy trap, inherited field or accessor execution. Foreign
 * native Errors may supply only their own bounded data message as an IO error.
 * Unknown values remain opaque; this does not infer execution outcomes. */
export function captureRemoteFileFailure(error:unknown):RemoteFileFailureDetails{
 const opaque=()=>Object.freeze({kind:'Io' as const,message:'Remote project file operation failed.'});
 if(error===null||typeof error!=='object'||types.isProxy(error))return opaque();
 const recorded=failures.get(error);if(recorded!==undefined)return recorded;
 if(!types.isNativeError(error))return opaque();
 const descriptor=Object.getOwnPropertyDescriptor(error,'message');if(descriptor===undefined||!Object.hasOwn(descriptor,'value')||typeof descriptor.value!=='string')return opaque();
 try{bounded(descriptor.value);}catch{return opaque();}
 return Object.freeze({kind:'Io',message:descriptor.value});
}
