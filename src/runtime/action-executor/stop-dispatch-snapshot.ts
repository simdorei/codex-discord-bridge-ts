import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {parseStopControlJson,serializeStopControl,type StopControl} from '../../store/stop-control-dispatch.ts';
import {assertStopDispatchInputBudget} from '../../store/stop-dispatch-budget.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotSettingsBinding} from './settings-snapshot.ts';
export const STOP_DISPATCH_REQUEST_BYTES=5*1024*1024,STOP_DISPATCH_REPLY_BYTES=65536;
export type StopDispatchOperation='Claim'|'Error';
/** Immutable original, including exact bigint and nested stored job strings.
 * Never reconstruct authority from a native response or current mutable row. */
export function captureStopDispatch(input:unknown):StopControl{
 assertStopDispatchInputBudget(input);const control=parseStopControlJson(serializeStopControl(input));
 for(const value of [control.operation_id,control.target,control.resident,control.turn]){requireDiscordText(value);if(Buffer.byteLength(value)>16384)throw new RangeError('Stop dispatch identity exceeds byte budget');}
 const binding=snapshotSettingsBinding(control.binding);if(binding.target!==control.target)throw new TypeError('Stop dispatch binding target differs');return control;
}
export function stopDispatchBinding(id:string,path:string,operation:StopDispatchOperation,c:StopControl){return {id,path,operation,operationId:c.operation_id,target:c.target,channel:c.channel,owner:c.owner,resident:c.resident,generation:c.generation,turn:c.turn};}
export function assertStopDispatchRequestBudget(binding:ReturnType<typeof stopDispatchBinding>,control:StopControl,token:string|null,diagnostic:string|null):void{
 const proof=snapshotSettingsBinding(control.binding).route==='Selected'&&binding.operation==='Claim'?{requestId:binding.id,operationId:control.operation_id,target:control.target,activeBytes:4}:null;
 if(boundedSerdeByteCount({...binding,control,token,diagnostic,proof},STOP_DISPATCH_REQUEST_BYTES)===null)throw new RangeError('Stop dispatch request exceeds transport byte budget');
 if(boundedSerdeByteCount({...binding,ok:true,token:'0'.repeat(36)},STOP_DISPATCH_REPLY_BYTES)===null)throw new RangeError('Stop dispatch identity exceeds acknowledgement byte budget');
}
/** Preserve the source's 1000 Unicode-scalar diagnostic limit without allocating
 * an array proportional to an arbitrarily large rendered message. */
export function captureStopDispatchDiagnostic(input:string):string{
 requireDiscordText(input);let result='',count=0;for(const scalar of input){if(count++===1000)break;result+=scalar;}return result;
}
