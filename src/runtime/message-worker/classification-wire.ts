import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import type {NewThreadOrigin} from '../../store/new-thread-origin.ts';
import {StoreIntegrityError,UnsupportedVersionError} from '../../store/schema-assembly.ts';
import {AbandonmentIntegrityError} from '../../store/schema-abandonment.ts';
import {AbandonmentRowMissingError} from '../../store/abandonment-identity.ts';
import {MessageAdmissionIntegerRangeError} from './classification-plan.ts';
export interface NativeMessageClassificationLimits{readonly maxRows:bigint;readonly maxValueBytes:bigint;readonly maxOutputBytes:number;readonly timeoutMs:number;}
export interface ClassificationReadResult{readonly origin:NewThreadOrigin;readonly arm:string|null;readonly abandonmentTarget:string|null;}
export class NativeMessageClassificationError extends Error{constructor(detail:string){super('Native message classification failed: '+detail);this.name='NativeMessageClassificationError';}}
export function captureNativeMessageClassificationLimits(input:NativeMessageClassificationLimits):NativeMessageClassificationLimits{
 const maxRows=own(input,'maxRows'),maxValueBytes=own(input,'maxValueBytes'),maxOutputBytes=own(input,'maxOutputBytes'),timeoutMs=own(input,'timeoutMs');
 if(typeof maxRows!=='bigint'||maxRows<1n||maxRows>4096n||typeof maxValueBytes!=='bigint'||maxValueBytes<1n||maxValueBytes>4194304n||typeof maxOutputBytes!=='number'||!Number.isSafeInteger(maxOutputBytes)||maxOutputBytes<1||maxOutputBytes>4194304||typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid native classification limits');
 return Object.freeze({maxRows,maxValueBytes,maxOutputBytes,timeoutMs});
}
function text(value:unknown):string{requireDiscordText(value);return value;}
function optionalText(value:unknown):string|null{return value===null?null:text(value);}
const i64=(value:unknown):value is bigint=>typeof value==='bigint'&&value>=-(1n<<63n)&&value<1n<<63n;
function fields(value:unknown,keys:readonly string[]):void{if(value===null||typeof value!=='object'||Object.getOwnPropertyNames(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new NativeMessageClassificationError('Invalid output fields');}
/** Bounded own-data decoder. The private owner separately verifies branch and
 * input identity, then constructs its non-transferable candidate. */
export function captureClassificationReadResult(value:unknown,channel:bigint,limits:NativeMessageClassificationLimits):ClassificationReadResult{
 if(boundedSerdeByteCount(value,limits.maxOutputBytes)===null)throw new NativeMessageClassificationError('Invalid or over-budget complete output');
 fields(value,['origin','arm','abandonmentTarget']);const origin=own(value,'origin');fields(origin,['version','channel','target','mapped_project','parent_channel','project','parent_project','chat_targets']);
 if(own(origin,'version')!==1n||own(origin,'channel')!==channel)throw new NativeMessageClassificationError('Output origin differs');
 for(const key of ['target','mapped_project','project','parent_project'])optionalText(own(origin,key));
 const parent=own(origin,'parent_channel');if(parent!==null&&!i64(parent))throw new NativeMessageClassificationError('Invalid parent channel');
 const targets=own(origin,'chat_targets');if(!Array.isArray(targets)||BigInt(targets.length)>limits.maxRows)throw new NativeMessageClassificationError('Invalid complete origin vector');for(const target of targets)text(target);
 optionalText(own(value,'arm'));optionalText(own(value,'abandonmentTarget'));return cloneOwnedSerdeValue(value) as ClassificationReadResult;
}
const bounded=(value:string)=>{let out='',count=0;for(const char of value){if(count++===2048)break;out+=char;}return out;};
export function classificationReadFailure(error:unknown):unknown{
 if(error instanceof MessageAdmissionIntegerRangeError)return {kind:'IntegerRange'};
 if(error instanceof StoreIntegrityError)return {kind:'StoreIntegrity',detail:bounded(error.result)};
 if(error instanceof UnsupportedVersionError)return {kind:'UnsupportedVersion',found:error.found,supported:error.supported};
 if(error instanceof AbandonmentIntegrityError)return {kind:'AbandonmentIntegrity',detail:bounded(error.reason)};
 if(error instanceof AbandonmentRowMissingError)return {kind:'AbandonmentRowMissing'};
 return {kind:error instanceof TypeError?'Type':error instanceof RangeError?'Range':'Native',detail:bounded(error instanceof Error?error.message:'Native read failed')};
}
export function throwClassificationReadFailure(value:unknown):never{
 if(boundedSerdeByteCount(value,16384)===null)throw new NativeMessageClassificationError('Invalid worker failure');const kind=own(value,'kind');
 if(kind==='IntegerRange'){fields(value,['kind']);throw new MessageAdmissionIntegerRangeError();}
 if(kind==='AbandonmentRowMissing'){fields(value,['kind']);throw new AbandonmentRowMissingError();}
 if(kind==='UnsupportedVersion'){fields(value,['kind','found','supported']);const found=own(value,'found'),supported=own(value,'supported');if(!i64(found)||!i64(supported))throw new NativeMessageClassificationError('Invalid schema failure');throw new UnsupportedVersionError(found,supported);}
 fields(value,['kind','detail']);const detail=text(own(value,'detail'));
 if(kind==='StoreIntegrity')throw new StoreIntegrityError(detail);if(kind==='AbandonmentIntegrity')throw new AbandonmentIntegrityError(detail);if(kind==='Type')throw new TypeError(detail);if(kind==='Range')throw new RangeError(detail);throw new NativeMessageClassificationError(detail);
}
