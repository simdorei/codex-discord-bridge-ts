import type {DatabaseSync} from 'node:sqlite';
import {usingExistingReadOnlyStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {checkAbandonmentCompatibility,AbandonmentIntegrityError} from './schema-abandonment.ts';
import {readAbandonmentProposalIn,readDeliveredAbandonmentIn,requireAbandonmentActor,requireAbandonmentDatabase,verifyAbandonmentFreshIn,type DeliveredAbandonmentProposal} from './abandonment-proposal-read.ts';
import {readAbandonmentDecisionIn} from './abandonment-decision.ts';
import {verifyAbandonmentClickIn,AbandonmentRowMissingError} from './abandonment-identity.ts';
import {asyncResolutionHeldIn} from './async-resolution-admission.ts';
import {receiptRow,receiptText,receiptTextColumns,receiptExists} from './delivery-receipt-key.ts';
import type {AbandonmentDecision,AbandonmentDecisionReceipt} from './abandonment-codec.ts';
import {requireDiscordText} from '../discord/text.ts';
import {serdeField} from '../app-server/value.ts';
import {isRustUuidText} from '../core/rust-uuid-text.ts';
const invalid=(reason:string):never=>{throw new AbandonmentIntegrityError(reason);};
const i64=(v:unknown):v is bigint=>typeof v==='bigint'&&v>=-(1n<<63n)&&v<1n<<63n;
function requireMapping(db:DatabaseSync,target:string,channel:bigint):void {
 if(!receiptExists(db,'SELECT count(*)=1 AND MAX(codex_thread_id=?1 AND discord_thread_id=?2) AS held FROM mirror_threads WHERE codex_thread_id=?1 OR discord_thread_id=?2',target,channel))invalid('exact original mapping is unavailable');
}
/** Read-only routing identity only. No selected-target fallback or permission. */
export function abandonmentCommandTarget(path:string,job:string,channel:bigint,owner:bigint):string {
 requireDiscordText(path);
 if(!i64(channel)||channel<=0n||!i64(owner)||owner<=0n||!isRustUuidText(job)||job.length!==36||job.toLowerCase()!==job)return invalid('exact job and authenticated actor are required');
 return usingExistingReadOnlyStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>{
  checkAbandonmentCompatibility(db,1n);
  const row=receiptRow(db,`SELECT target_thread_id,${receiptTextColumns('target_thread_id')} FROM codex_turn_queue WHERE job_id=? AND channel_id=? AND owner_user_id=?
   AND state='pending' AND turn_id IS NULL AND goal_waiting=0 AND discord_message_id>0 AND app_server_generation>0 AND length(target_thread_id) BETWEEN 1 AND 256`,job,channel,owner);
  if(row===undefined)throw new AbandonmentRowMissingError();const target=receiptText(row,'target_thread_id')!;
  if(!asyncResolutionHeldIn(db,target))return invalid('original request is not held');requireMapping(db,target,channel);return commitStore(target);
 }));
}
export interface AbandonmentDecisionRouteInput {
 readonly proposal_id:string;readonly revision:bigint;readonly interaction_id:bigint;readonly application_id:bigint;readonly channel_id:bigint;
 readonly owner_user_id:bigint;readonly source_message_id:bigint;readonly decision:AbandonmentDecision;readonly now:number;
}
/** Called before ACK and again under the runtime target lock. A new event needs
 * fresh proposal evidence; only its exact consumed event can use historical data. */
export function authorizeAbandonmentDecision(path:string,value:AbandonmentDecisionRouteInput):DeliveredAbandonmentProposal {
 requireDiscordText(path);const id=serdeField(value,'proposal_id'),revision=serdeField(value,'revision'),event=serdeField(value,'interaction_id'),app=serdeField(value,'application_id'),channel=serdeField(value,'channel_id'),owner=serdeField(value,'owner_user_id'),message=serdeField(value,'source_message_id'),decision=serdeField(value,'decision'),now=serdeField(value,'now');
 requireDiscordText(id);if(!i64(revision)||!i64(app)||!i64(channel)||!i64(owner)||!i64(message))throw new TypeError('Expected i64 abandonment routing identities');
 if(!i64(event)||event<=0n||typeof now!=='number'||!Number.isFinite(now)||now<0)return invalid('invalid authenticated interaction identity');
 if(decision!=='AbandonOnly'&&decision!=='KeepHeld')throw new TypeError('Expected abandonment decision');
 return usingExistingReadOnlyStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>{
  const stored=readAbandonmentProposalIn(db,id);requireAbandonmentDatabase(path,stored);const delivered=readDeliveredAbandonmentIn(db,id,revision);
  requireAbandonmentActor(delivered,app,channel,owner,message);requireMapping(db,delivered.proposal.thread_id,channel);
  const receipt=readAbandonmentDecisionIn(db,stored);
  if(receipt!==null){const ingress='interaction:'+event;
   if(receipt.ingress_id!==ingress||receipt.interaction_id!==event||receipt.decision!==decision||verifyAbandonmentClickIn(db,stored,ingress,decision,false)!==event)
    return invalid('decision was already consumed by another interaction');
  }else verifyAbandonmentFreshIn(db,path,stored,now);
  return commitStore(delivered);
 }));
}
/** Historical read-only identity. Does not assert freshness or grant consent. */
export function deliveredAbandonmentProposal(path:string,id:string,revision:bigint):DeliveredAbandonmentProposal {
 requireDiscordText(path);requireDiscordText(id);if(!i64(revision))throw new TypeError('Expected i64 revision');
 return usingExistingReadOnlyStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>{
  const stored=readAbandonmentProposalIn(db,id);requireAbandonmentDatabase(path,stored);return commitStore(readDeliveredAbandonmentIn(db,id,revision));
 }));
}
export function abandonmentDecisionStatus(path:string,id:string,revision:bigint):AbandonmentDecisionReceipt|null {
 requireDiscordText(path);requireDiscordText(id);if(!i64(revision))throw new TypeError('Expected i64 revision');
 return usingExistingReadOnlyStore(path,db=>withStoreTransaction(db,'DEFERRED',()=>{
  const stored=readAbandonmentProposalIn(db,id);requireAbandonmentDatabase(path,stored);
  if(revision<1n||stored.proposal.revision!==revision)return invalid('status revision differs');
  return commitStore(readAbandonmentDecisionIn(db,stored));
 }));
}
