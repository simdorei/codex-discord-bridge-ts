import type {DatabaseSync} from 'node:sqlite';
import {boundedSerdeByteCount} from '../core/serde-byte-count.ts';
import {getOwn} from './async-resolution-json-helpers.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {StopAcceptanceBudget,STOP_ACCEPTANCE_MAX_ROWS,STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES} from './stop-acceptance-budget.ts';
import type {StopControl} from './stop-control-dispatch.ts';

/** Same finite evidence policy as acceptance. Charge before cloning/parsing the
 * original's nested job JSON; this is capacity refusal, never new authority. */
export function assertStopDispatchInputBudget(input:unknown):void{
 if(boundedSerdeByteCount(input,STOP_ACCEPTANCE_MAX_EVIDENCE_BYTES)===null)throw new StoreIntegrityError('Stop dispatch original exceeds passive evidence byte budget');
 const jobs=getOwn(input,'jobs');if(!Array.isArray(jobs)||jobs.length>STOP_ACCEPTANCE_MAX_ROWS)throw new StoreIntegrityError('Stop dispatch original exceeds row budget');
}
/** A new budget for one IMMEDIATE claim transaction, shared by both validation
 * passes. Every current row/mapping/hold is measured before its decoder, and
 * repeated reads count again. Never repair schema or preflight outside custody. */
export function stopDispatchBudget(db:DatabaseSync,control:StopControl):StopAcceptanceBudget{
 return new StopAcceptanceBudget(db,control.target,control.channel,getOwn(control.binding,'route'),null);
}
