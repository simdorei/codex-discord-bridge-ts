import {types} from 'node:util';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import type {StoredIngress} from '../../store/ingress-read.ts';
import type {StopScope} from '../../store/stop-acceptance.ts';
import {snapshotSettingsBinding,type FrozenSettingsBinding} from './settings-snapshot.ts';

/** Deliberate finite transport limits, not measured throughput/parity claims. */
export const STOP_ACCEPTANCE_INPUT_BYTES=262144,STOP_ACCEPTANCE_REPLY_BYTES=65536;
const INGRESS_FIELDS=['ingressId','kind','eventId','applicationId','channelId','ownerUserId','sourceMessageId','payload','runtimeId','state','phase','targetThreadId','canonicalOwner','ownerKind','ownerId','outcome','confirmationDelivered','holdReason','createdAt','updatedAt'] as const;
export interface StopAcceptanceInput {
 readonly scope:StopScope;readonly binding:FrozenSettingsBinding;readonly ingress:StoredIngress;
 readonly resident:{readonly id:string;readonly generation:bigint}|null;readonly now:number;
}
/** Absence of outcome has its own bit so all cloned data stays passive Serde. */
export interface StopAcceptanceOperation extends StopAcceptanceInput {readonly hasOutcome:boolean;readonly operationId:string}
export type StopAcceptanceDisplay={readonly kind:'Running';readonly operationId:string}|{readonly kind:'Unresolved';readonly operationId:string;readonly jobs:number;readonly ingresses:number};
export function stopAcceptanceText(value:unknown):asserts value is string {
 requireDiscordText(value);if(value.length>16384||Buffer.byteLength(value)>16384)throw new RangeError('Stop acceptance text exceeds native budget');
}
function integer(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<=0n||value>=1n<<63n)throw new TypeError('Expected positive signed Stop identity');}
function record(input:unknown,fields:number):void{if(input===null||typeof input!=='object'||types.isProxy(input)||Array.isArray(input)||Reflect.ownKeys(input).length!==fields||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.values(Object.getOwnPropertyDescriptors(input)).some(d=>!d.enumerable||!Object.hasOwn(d,'value')))throw new TypeError('Expected exact Stop data record');}
/** Budget before deep clone/parse, including payload and optional outcome. */
export function captureStopAcceptance(input:StopAcceptanceInput):StopAcceptanceOperation {
 record(input,5);const rawIngress=own(input,'ingress'),ingress:Record<string,unknown>={};record(rawIngress,INGRESS_FIELDS.length);
 for(const field of INGRESS_FIELDS)ingress[field]=own(rawIngress,field);
 // Typed SQLite timestamps preserve REAL infinities; they are not Serde Value
 // fields. Charge fixed passive numeric sentinels, then restore exact scalars.
 const createdAt=ingress.createdAt,updatedAt=ingress.updatedAt;
 for(const timestamp of [createdAt,updatedAt])if(typeof timestamp!=='number'||Number.isNaN(timestamp))throw new TypeError('Expected original Stop timestamp');
 ingress.createdAt=0;ingress.updatedAt=0;
 const hasOutcome=ingress.outcome!==undefined;if(!hasOutcome)ingress.outcome=null;
 const raw={scope:own(input,'scope'),binding:own(input,'binding'),ingress,resident:own(input,'resident'),now:own(input,'now'),hasOutcome};
 if(boundedSerdeByteCount(raw,STOP_ACCEPTANCE_INPUT_BYTES)===null)throw new RangeError('Stop acceptance input exceeds passive byte budget');
 const captured=cloneOwnedSerdeValue(raw) as Omit<StopAcceptanceOperation,'operationId'>,s=captured.scope,i=captured.ingress;
 record(s,3);stopAcceptanceText(s.target);integer(s.channel);integer(s.owner);
 const binding=snapshotSettingsBinding(captured.binding);stopAcceptanceText(binding.target);
 stopAcceptanceText(i.ingressId);integer(i.eventId);
 if(i.ingressId!==`message:${i.eventId}`||i.kind!=='message'||i.sourceMessageId!==i.eventId||i.channelId!==s.channel||i.ownerUserId!==s.owner||i.targetThreadId!==s.target||binding.target!==s.target||i.state!=='executing'||i.phase!=='processing'||i.ownerId!==null||i.ownerKind!==null)throw new TypeError('Original Stop ingress identity differs');
 if(captured.resident!==null){record(captured.resident,2);stopAcceptanceText(captured.resident.id);if(captured.resident.id==='')throw new TypeError('Expected original resident identity');integer(captured.resident.generation);}
 if(typeof captured.now!=='number'||!Number.isFinite(captured.now)||captured.now<0)throw new TypeError('Expected Stop acceptance timestamp');
 const operationId=`stop:${i.ingressId}`;stopAcceptanceText(operationId);
 return Object.freeze({...captured,ingress:Object.freeze({...i,createdAt:createdAt as number,updatedAt:updatedAt as number}),binding,operationId});
}
export function stopAcceptanceIngress(operation:StopAcceptanceOperation):StoredIngress{return {...operation.ingress,outcome:operation.hasOutcome?operation.ingress.outcome:undefined};}
export function stopAcceptanceBinding(id:string,path:string,operation:StopAcceptanceOperation){return {id,path,operationId:operation.operationId,ingressKey:operation.ingress.ingressId,eventId:operation.ingress.eventId,target:operation.scope.target,channelId:operation.scope.channel,ownerUserId:operation.scope.owner,resident:operation.resident?.id??null,generation:operation.resident?.generation??null};}

/** Includes duplicated envelope identities and Selected proof metadata in the
 * finite transport budget before lease acquisition. The private shared word is
 * charged as a fixed scalar; typed SQLite timestamps use fixed-size sentinels. */
export function assertStopAcceptanceRequestBudget(binding:ReturnType<typeof stopAcceptanceBinding>,operation:StopAcceptanceOperation):void{
 const request={...binding,operation:{...operation,ingress:{...operation.ingress,createdAt:123456789,updatedAt:123456789}},proof:operation.binding.route==='Selected'?{requestId:binding.id,operationId:operation.operationId,target:operation.scope.target,activeBytes:4}:null};
 if(boundedSerdeByteCount(request,STOP_ACCEPTANCE_INPUT_BYTES)===null)throw new RangeError('Stop acceptance request envelope exceeds transport byte budget');
}
