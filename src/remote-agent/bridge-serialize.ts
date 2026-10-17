import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {formatRemoteUtcDateTime} from './datetime-format.ts';
import type {RemoteUtcDateTime} from './datetime.ts';
import {parseBridgeInboundMessage} from './bridge-inbound.ts';
import type {BridgeInboundMessage} from './bridge-inbound.ts';
import {object} from './request-input.ts';

/** Bounded pure serializer for decoded bridge DTOs. Passive preflight rejects
 * accessors, proxies, cycles, symbols and opaque objects before serialization.
 * Datetimes are emitted as Chrono UTC strings, never internal bigint objects.
 * Final protocol validation is an additional fail-closed outgoing profile.
 * This synchronous leaf is not yet a native send pipeline or redaction boundary. */
export function serializeBridgeInboundMessage(value:BridgeInboundMessage,maxBytes:number):string{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid bridge output byte budget');
 if(boundedSerdeByteCount(value,maxBytes+32768)===null)throw new TypeError('Invalid or over-budget bridge output DTO');
 // No await or caller callback occurs between passive inspection and snapshot.
 const snapshot=object(parseSerdeValue(serializeSerdeValue(value)));
 if(snapshot.type==='project_upsert')snapshot.expires_at=formatRemoteUtcDateTime(snapshot.expires_at as RemoteUtcDateTime);
 if(snapshot.type==='project_operation_result'){
  const output=object(snapshot.output);
  if(output.kind==='terminal_window_capture')output.captured_at=formatRemoteUtcDateTime(output.captured_at as RemoteUtcDateTime);
  if(output.kind==='terminal_window_action'){
   const receipt=object(output.receipt);receipt.completed_at=formatRemoteUtcDateTime(receipt.completed_at as RemoteUtcDateTime);
  }
 }
 if(boundedSerdeByteCount(snapshot,maxBytes)===null)throw new RangeError('Bridge wire output exceeds byte budget');
 const raw=serializeSerdeValue(snapshot);
 parseBridgeInboundMessage(raw,maxBytes);
 return raw;
}
