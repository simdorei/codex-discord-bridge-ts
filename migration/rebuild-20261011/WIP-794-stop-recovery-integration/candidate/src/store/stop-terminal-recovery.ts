import type {DatabaseSync,SQLInputValue} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {parseStopControlJson,serializeStopControl,retainedStopControlIn,type StopControl} from './stop-control-dispatch.ts';
import {validateStopBindingIn,stopHoldSnapshotIn} from './stop-custody-common.ts';
import {validateStoppedTerminalObservation} from './stop-terminal-observation.ts';
import {captureStopRecoveryCustodyIn} from './stop-recovery-custody.ts';
import {cancelRecoveryRequestIn,type RecoveryCancellation} from './queue-cancel-recovery.ts';
import {settleStoppedExecutionIn} from './async-history.ts';
import {decodeI64,decodeTextField,textDecoderFor} from './sqlite-values.ts';
import {rustTrim} from './restart-snapshot-pure.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
function refused():never{throw new StoreIntegrityError('original stop control authority differs; no interrupt or replay');}
function exists(db:DatabaseSync,sql:string,...args:SQLInputValue[]):boolean{const q=db.prepare(sql);q.setReadBigInts(true);return decodeI64(q.get(...args)?.n,'exists')!==0n;}
/** Borrowed transaction only: caller owns IMMEDIATE transaction and current native
 * read lifetime + unsealed permit through commit. Does not open/commit/rollback.
 * Throw requires caller rollback; success alone is never a commit authorization. */
export function recoverStoppedTerminalIn(db:DatabaseSync,input:StopControl,observation:unknown,reader:string,generation:bigint,now:number):number{
 const control=parseStopControlJson(serializeStopControl(input));
 if(!db.isTransaction||!control.can_settle||control.jobs.length===0||control.jobs.length>128||typeof reader!=='string'||/[\uD800-\uDFFF]/u.test(reader)||rustTrim(reader)===''||Buffer.byteLength(reader)>256||typeof generation!=='bigint'||generation<=0n||generation>=(1n<<63n)||typeof now!=='number'||!Number.isFinite(now)||now<0||!retainedStopControlIn(db,control))refused();
 const observed=cloneOwnedSerdeValue(observation);validateStoppedTerminalObservation(control,observed);validateStopBindingIn(db,control.target,control.channel,control.binding);
 if(exists(db,"SELECT EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=?1) OR EXISTS(SELECT 1 FROM codex_mutation_attempts WHERE target_thread_id=?1 AND state='prepared') AS n",control.target))refused();
 const custody=captureStopRecoveryCustodyIn(db,control),cancelled:RecoveryCancellation={jobs:[],startedOrUncertain:0};
 for(const job of custody.jobs)cancelRecoveryRequestIn(db,control.target,control.channel,control.owner,now,job.jobId,'queue',job.discordMessageId,cancelled);
 settleStoppedExecutionIn(db,control.target,control.turn,observed,reader,generation);
 const row=db.prepare('SELECT terminal_json,CAST(terminal_json AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM cdr_stop_controls WHERE operation_id=?').get(control.operation_id);if(row===undefined)refused();
 const prior=decodeTextField(row!.terminal_json,row!.raw,'terminal_json',true,textDecoderFor(row!.encoding));
 const proof=serializeSerdeValue({source:'stop_terminal_history_v1',observer:reader,generation,operation_id:control.operation_id,observation:observed,previous_terminal:prior});
 if(BigInt(db.prepare("UPDATE cdr_stop_controls SET phase='settled',terminal_json=? WHERE operation_id=? AND record_json=?").run(proof,control.operation_id,serializeStopControl(control)).changes)!==1n)refused();
 for(const hold of custody.holds)if(!isDeepStrictEqual(stopHoldSnapshotIn(db,hold.id),hold.snapshot))refused();
 for(const job of custody.jobs)if(!exists(db,'SELECT NOT EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?1) AND EXISTS(SELECT 1 FROM codex_request_cancellations WHERE job_id=?1 AND target_thread_id=?2 AND channel_id=?3 AND owner_user_id=?4) AS n',job.jobId,control.target,control.channel,control.owner))refused();
 const saved=db.prepare("SELECT terminal_json,CAST(terminal_json AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding FROM cdr_stop_controls WHERE operation_id=? AND phase='settled'").get(control.operation_id);
 if(saved===undefined||decodeTextField(saved.terminal_json,saved.raw,'terminal_json',false,textDecoderFor(saved.encoding))!==proof||!retainedStopControlIn(db,control))refused();return cancelled.jobs.length;
}
