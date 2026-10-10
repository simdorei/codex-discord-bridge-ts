import type {DatabaseSync} from 'node:sqlite';
import {usingExistingStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {AbandonmentIntegrityError} from './schema-abandonment.ts';
import {readAbandonmentProposalIn,requireAbandonmentDatabase,verifyAbandonmentFreshIn,latestAbandonmentRevisionIn} from './abandonment-proposal-read.ts';
import {verifyAbandonmentClickIn} from './abandonment-identity.ts';
import {captureAbandonmentJobRowIn,captureAbandonmentContextIn} from './abandonment-snapshot.ts';
import {serializeStoredAbandonmentProposal,type StoredAbandonmentProposal,type AbandonmentDecision,type AbandonmentDecisionReceipt} from './abandonment-codec.ts';
import {publicationTimeBits,publicationTimeFromBits} from './publication-codec.ts';
import {receiptRow,receiptText,receiptTextColumns,receiptExists} from './delivery-receipt-key.ts';
import {decodeI64,decodeOptionalI64,decodeTimestamp} from './sqlite-values.ts';
import {serdeField} from '../app-server/value.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
import {requireDiscordText} from '../discord/text.ts';
import {parseRustU64} from '../config/remote.ts';
const invalid=(reason:string):never=>{throw new AbandonmentIntegrityError(reason);};
export interface AbandonmentDecisionInput {readonly proposal_id:string;readonly revision:bigint;readonly ingress_id:string;readonly decision:AbandonmentDecision;readonly now:number}
function originalMessage(stored:StoredAbandonmentProposal):bigint {
 const row=serdeField(stored.snapshot,'job'),columns=serdeField(row,'columns');
 if(!Array.isArray(columns))return invalid('original row columns missing');
 const index=columns.findIndex(v=>v==='discord_message_id');if(index<0)return invalid('original event column missing');
 const rows=serdeField(row,'rows'),first=Array.isArray(rows)?rows[0]:undefined,cell=Array.isArray(first)?first[index]:undefined;
 if(!Array.isArray(cell)||cell[0]!=='integer')return invalid('original event identity missing');
 if(typeof cell[1]!=='bigint'||cell[1]<=0n||cell[1]>=1n<<63n)return invalid('original event identity invalid');return cell[1];
}
function cancellationIn(db:DatabaseSync,job:string):unknown|null {
 const row=receiptRow(db,`SELECT job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,cancelled_at,
 ${receiptTextColumns('job_id','target_thread_id')} FROM codex_request_cancellations WHERE job_id=?`,job);
 return row===undefined?null:[receiptText(row,'job_id'),receiptText(row,'target_thread_id'),decodeI64(row.channel_id,'channel'),decodeOptionalI64(row.owner_user_id,'owner'),decodeOptionalI64(row.discord_message_id,'message'),publicationTimeBits(decodeTimestamp(row.cancelled_at,'cancelled_at'))];
}
function requireAppliedIn(db:DatabaseSync,stored:StoredAbandonmentProposal,receipt:AbandonmentDecisionReceipt):void {
 if(receipt.decision!=='AbandonOnly')return;const p=stored.proposal;
 const queued=receiptExists(db,'SELECT EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?) AS held',p.job_id);
 const expected=[p.job_id,p.thread_id,p.channel_id,p.owner_user_id,originalMessage(stored),receipt.recorded_at_bits];
 if(queued||!serdeValueEqual(cancellationIn(db,p.job_id),expected))invalid('disposition has no exact non-executable tombstone');
}
/** Durable receipt read checks that AbandonOnly still has an exact cancellation
 * tombstone and no executable queue row. It never manufactures retry authority. */
export function readAbandonmentDecisionIn(db:DatabaseSync,stored:StoredAbandonmentProposal):AbandonmentDecisionReceipt|null {
 const p=stored.proposal,row=receiptRow(db,`SELECT revision,ingress_id,interaction_id,decision,recorded_at_bits,
 ${receiptTextColumns('ingress_id','decision','recorded_at_bits')} FROM cdr_recovery_abandonment_decisions WHERE proposal_id=?`,p.id);
 if(row===undefined)return null;
 const revision=decodeI64(row.revision,'revision'),ingress=receiptText(row,'ingress_id')!,event=decodeI64(row.interaction_id,'interaction_id'),choice=receiptText(row,'decision');
 const bits=parseRustU64(receiptText(row,'recorded_at_bits')!);if(bits===null)return invalid('invalid disposition timestamp');
 const now=publicationTimeFromBits(bits),decision=choice==='abandon_only'?'AbandonOnly':choice==='keep_held'?'KeepHeld':invalid('unsupported disposition');
 if(revision!==p.revision||event<=0n||ingress.length===0||!Number.isFinite(now)||now<publicationTimeFromBits(p.created_at_bits)||now>=publicationTimeFromBits(p.expires_at_bits))return invalid('disposition identity or timestamp differs');
 const receipt:AbandonmentDecisionReceipt=Object.freeze({proposal_id:p.id,revision,job_id:p.job_id,thread_id:p.thread_id,ingress_id:ingress,interaction_id:event,decision,recorded_at_bits:bits});
 requireAppliedIn(db,stored,receipt);return receipt;
}
function abandonIn(db:DatabaseSync,path:string,stored:StoredAbandonmentProposal,receipt:AbandonmentDecisionReceipt):void {
 const p=stored.proposal,now=publicationTimeFromBits(receipt.recorded_at_bits);
 if(db.prepare('INSERT INTO codex_request_cancellations (job_id,target_thread_id,channel_id,owner_user_id,discord_message_id,cancelled_at) VALUES(?,?,?,?,?,?)')
  .run(p.job_id,p.thread_id,p.channel_id,p.owner_user_id,originalMessage(stored),now).changes!==1)return invalid('irreversible cancellation insert was ignored');
 const target={job:p.job_id,thread:p.thread_id,owner:p.owner_user_id,channel:p.channel_id},budget={bytes:0};
 if(!serdeValueEqual(captureAbandonmentJobRowIn(db,p.job_id,budget),serdeField(stored.snapshot,'job'))
  ||!serdeValueEqual(captureAbandonmentContextIn(db,path,target,stored.source_ingress,false,budget),serdeField(stored.snapshot,'context')))
  return invalid('original evidence changed during disposition');
 if(db.prepare("DELETE FROM codex_turn_queue WHERE job_id=? AND target_thread_id=? AND state='pending' AND turn_id IS NULL").run(p.job_id,p.thread_id).changes!==1)return invalid('exact original Pending removal did not apply');
 requireAppliedIn(db,stored,receipt);
 if(!serdeValueEqual(captureAbandonmentContextIn(db,path,target,stored.source_ingress,false,{bytes:0}),serdeField(stored.snapshot,'context')))
  invalid('disposition altered another request or a lifecycle barrier');
}
/** Runtime caller must retain admission and shared target lock across this entire
 * synchronous existing-only transaction. Never releases a hold or issues RPC. */
export function recordAbandonmentDecision(path:string,value:AbandonmentDecisionInput):AbandonmentDecisionReceipt {
 requireDiscordText(path);const id=serdeField(value,'proposal_id'),revision=serdeField(value,'revision'),ingress=serdeField(value,'ingress_id'),decision=serdeField(value,'decision'),now=serdeField(value,'now');
 requireDiscordText(id);requireDiscordText(ingress);
 if(typeof revision!=='bigint'||revision<1n||revision>=1n<<63n||typeof now!=='number'||!Number.isFinite(now)||now<0)return invalid('invalid decision revision or host time');
 if(decision!=='AbandonOnly'&&decision!=='KeepHeld')throw new TypeError('Expected abandonment decision');
 return usingExistingStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  const stored=readAbandonmentProposalIn(db,id);requireAbandonmentDatabase(path,stored);const p=stored.proposal;
  if(p.revision!==revision)return invalid('decision revision differs');
  const existing=readAbandonmentDecisionIn(db,stored);
  if(existing!==null){const event=verifyAbandonmentClickIn(db,stored,ingress,decision,false);
   if(existing.ingress_id!==ingress||existing.interaction_id!==event||existing.decision!==decision)return invalid('decision was already consumed by another interaction');return commitStore(existing);}
  verifyAbandonmentFreshIn(db,path,stored,now);const event=verifyAbandonmentClickIn(db,stored,ingress,decision,true);
  const receipt:AbandonmentDecisionReceipt=Object.freeze({proposal_id:p.id,revision:p.revision,job_id:p.job_id,thread_id:p.thread_id,ingress_id:ingress,interaction_id:event,decision,recorded_at_bits:publicationTimeBits(now)});
  if(db.prepare('INSERT INTO cdr_recovery_abandonment_decisions VALUES(?,?,?,?,?,?)').run(p.id,p.revision,ingress,event,decision==='AbandonOnly'?'abandon_only':'keep_held',receipt.recorded_at_bits.toString()).changes!==1)return invalid('decision insert was ignored');
  if(decision==='AbandonOnly')abandonIn(db,path,stored,receipt);else verifyAbandonmentFreshIn(db,path,stored,now);
  const retained=readAbandonmentProposalIn(db,p.id);
  if(serializeStoredAbandonmentProposal(retained)!==serializeStoredAbandonmentProposal(stored)
   ||!serdeValueEqual(readAbandonmentDecisionIn(db,retained),receipt)||verifyAbandonmentClickIn(db,retained,ingress,decision,true)!==event)
   return invalid('decision or original evidence was lost or altered');
  if(latestAbandonmentRevisionIn(db,p.job_id)!==p.revision)return invalid('proposal was superseded during disposition');
  return commitStore(receipt);
 }));
}
