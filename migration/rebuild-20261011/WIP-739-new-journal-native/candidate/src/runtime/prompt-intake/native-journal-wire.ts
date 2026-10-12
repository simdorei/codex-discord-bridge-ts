import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import type {StoredIngress,IngressKind} from '../../store/ingress-read.ts';
import {snapshotNewIngress,type NewIngress} from '../../store/ingress-types.ts';
import {intakeNumberWire,intakeNumberFromWire} from './native-wire.ts';

function text(value:unknown):string {
 if(typeof value!=='string'||/[\uD800-\uDFFF]/u.test(value))throw new TypeError('Invalid journal wire text');return value;
}
function optionalText(value:unknown):string|null {return value===null?null:text(value);}
function integer(value:unknown):bigint {
 if(typeof value!=='bigint'||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError('Invalid journal wire i64');return value;
}
function optionalInteger(value:unknown):bigint|null {return value===null?null:integer(value);}
function kind(value:unknown):IngressKind {
 if(value!=='message'&&value!=='interaction'&&value!=='action')throw new TypeError('Invalid journal wire kind');return value;
}
function boolean(value:unknown):boolean {if(typeof value!=='boolean')throw new TypeError('Invalid journal wire boolean');return value;}
function scalars(input:unknown) {
 return {
  ingressId:text(own(input,'ingressId')),kind:kind(own(input,'kind')),
  eventId:optionalInteger(own(input,'eventId')),applicationId:optionalInteger(own(input,'applicationId')),
  channelId:integer(own(input,'channelId')),ownerUserId:integer(own(input,'ownerUserId')),
  sourceMessageId:optionalInteger(own(input,'sourceMessageId')),runtimeId:optionalText(own(input,'runtimeId')),
  state:text(own(input,'state')),phase:text(own(input,'phase')),targetThreadId:optionalText(own(input,'targetThreadId')),
  canonicalOwner:optionalText(own(input,'canonicalOwner')),ownerKind:optionalText(own(input,'ownerKind')),
  ownerId:optionalText(own(input,'ownerId')),confirmationDelivered:boolean(own(input,'confirmationDelivered')),
  holdReason:text(own(input,'holdReason')),
 };
}
/** Complete record, not an admission-authority projection. JSON strings preserve
 * Serde integer/f64 distinctions across structured clone; SQL NULL outcome and
 * parsed JSON null remain distinct. The enclosing worker enforces packet size. */
export function storedIngressToWire(input:StoredIngress):unknown {
 const value=scalars(input),payloadJson=serializeSerdeValue(own(input,'payload')),outcome=own(input,'outcome');
 return {...value,payloadJson,outcomePresent:outcome!==undefined,outcomeJson:outcome===undefined?null:serializeSerdeValue(outcome),
  createdAt:intakeNumberWire(own(input,'createdAt') as number),updatedAt:intakeNumberWire(own(input,'updatedAt') as number)};
}
export function storedIngressFromWire(input:unknown):StoredIngress {
 const value=scalars(input),payload=parseSerdeValue(text(own(input,'payloadJson'))),present=boolean(own(input,'outcomePresent')),raw=own(input,'outcomeJson');
 if(!present&&raw!==null)throw new TypeError('Invalid absent journal outcome');
 const outcome=present?parseSerdeValue(text(raw)):undefined;
 return {...value,payload,outcome,createdAt:intakeNumberFromWire(own(input,'createdAt')),updatedAt:intakeNumberFromWire(own(input,'updatedAt'))};
}
/** Captures all caller-owned values synchronously before any worker admission. */
export function newIngressToWire(input:NewIngress):unknown {
 const value=snapshotNewIngress(input);
 const {payload,now,...rest}=value;return {...rest,payloadJson:serializeSerdeValue(payload),now:intakeNumberWire(now)};
}
export function newIngressFromWire(input:unknown):NewIngress {
 return snapshotNewIngress({
  ingressId:text(own(input,'ingressId')),kind:kind(own(input,'kind')),
  eventId:optionalInteger(own(input,'eventId')),applicationId:optionalInteger(own(input,'applicationId')),
  channelId:integer(own(input,'channelId')),ownerUserId:integer(own(input,'ownerUserId')),
  sourceMessageId:optionalInteger(own(input,'sourceMessageId')),payload:parseSerdeValue(text(own(input,'payloadJson'))),
  targetThreadId:optionalText(own(input,'targetThreadId')),canonicalOwner:optionalText(own(input,'canonicalOwner')),
  now:intakeNumberFromWire(own(input,'now')),
 });
}
