import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {serdeField as field} from '../app-server/value.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {parseStopControlJson,serializeStopControl,type StopControl} from './stop-control-dispatch.ts';
/** Pure PR5 observation predicate only. No native lifetime, transaction, custody,
 * cancellation, settlement, commit permission, or runtime recovery installation. */
export function validateStoppedTerminalObservation(input:StopControl,observed:unknown):void{
 const control=parseStopControlJson(serializeStopControl(input));
 const refuse=():never=>{throw new StoreIntegrityError('original stop control authority differs; no interrupt or replay');};
 if(boundedSerdeByteCount(observed,1_048_576)===null)refuse();
 const goal=field(field(observed,'goal_observation'),'goal'),turns=field(observed,'turns'),thread=field(field(observed,'thread_observation'),'thread');
 if(field(observed,'threadId')!==control.target||field(observed,'truncated')!==false||field(observed,'required_owners_complete')!==true||field(thread,'id')!==control.target||!['idle','notLoaded'].includes(field(field(thread,'status'),'type') as string)||field(thread,'archived')===true||!(goal===null||(goal!==undefined&&field(goal,'threadId')===control.target&&field(goal,'status')==='complete'))||!Array.isArray(turns)||turns.length!==1||field(turns[0],'id')!==control.turn||!['completed','interrupted','failed'].includes(field(turns[0],'status') as string)||field(turns[0],'truncated')===true)refuse();
}
