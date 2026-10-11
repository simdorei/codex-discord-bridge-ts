import {createHash} from 'node:crypto';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {serializeSerdeValue,toCanonicalJson} from '../core/serde-json.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {formatRemoteUtcDateTime} from './datetime-format.ts';
import type {RemoteUtcDateTime} from './datetime.ts';
import {parseGatewayCommand,type GatewayCommand} from './gateway-command.ts';
import {object} from './request-input.ts';
function dates(snapshot:Record<string,unknown>):void{
 snapshot.deadline_at=formatRemoteUtcDateTime(snapshot.deadline_at as RemoteUtcDateTime);
 if(snapshot.type==='device_session')snapshot.expires_at=formatRemoteUtcDateTime(snapshot.expires_at as RemoteUtcDateTime);
}
/** Worker leaf: Rust canonical_json plus SHA256, excluding ONLY top-level
 * deadline_at/request_id. Typed dates serialize as Chrono UTC strings first.
 * Bounded decode/normalization retains explicit null/default Serde fields.
 * This is a content identity, never a mutation receipt or authorization. */
export function fingerprintGatewayCommand(value:GatewayCommand,maxBytes:number):string{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid command fingerprint budget');
 if(boundedSerdeByteCount(value,maxBytes+32768)===null)throw new TypeError('Invalid or over-budget command DTO');
 const snapshot=object(parseSerdeValue(serializeSerdeValue(value)));dates(snapshot);
 if(boundedSerdeByteCount(snapshot,maxBytes)===null)throw new RangeError('Command fingerprint wire exceeds budget');
 const decoded=parseGatewayCommand(serializeSerdeValue(snapshot),maxBytes);
 const normalized=object(parseSerdeValue(serializeSerdeValue(decoded)));dates(normalized);
 const canonical=toCanonicalJson(normalized,['deadline_at','request_id']);
 return createHash('sha256').update(canonical,'utf8').digest('hex');
}
