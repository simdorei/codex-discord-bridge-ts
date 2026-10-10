import {usingExistingStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {checkAbandonmentCompatibility,AbandonmentIntegrityError} from './schema-abandonment.ts';
import {captureAbandonmentSnapshotIn} from './abandonment-snapshot.ts';
import {readOptionalAbandonmentProposalIn,readAbandonmentProposalIn,latestAbandonmentRevisionIn,verifyAbandonmentFreshIn,readDeliveredAbandonmentIn,MAX_ABANDONMENT_SEAL_BYTES} from './abandonment-proposal-read.ts';
import {serializeStoredAbandonmentProposal,type StoredAbandonmentProposal,type AbandonmentProposal} from './abandonment-codec.ts';
import {publicationDigest,publicationTimeBits,validPublicationId} from './publication-codec.ts';
import {receiptRow,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64} from './sqlite-values.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
import {serdeField} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {formatRustF64Display} from '../core/rust-f64-display.ts';
import {isRustUuidText} from '../core/rust-uuid-text.ts';
export interface AbandonmentProposalInput {readonly proposal_id:string;readonly job_id:string;readonly ingress_id:string;readonly application_id:bigint;readonly now:number;readonly expires_at:number}
const invalid=(reason:string):never=>{throw new AbandonmentIntegrityError(reason);};
function input(value:AbandonmentProposalInput):AbandonmentProposalInput {
 const now=serdeField(value,'now'),expires=serdeField(value,'expires_at');
 if(typeof now!=='number'||typeof expires!=='number'||!Number.isFinite(now)||!Number.isFinite(expires))return invalid('invalid proposal identity or bounded lifetime');
 const i=cloneOwnedSerdeValue(value) as AbandonmentProposalInput;
 if(!validPublicationId(i.proposal_id)||!isRustUuidText(i.job_id)||typeof i.application_id!=='bigint'||i.application_id<=0n||i.application_id>=1n<<63n
  ||typeof i.ingress_id!=='string'||i.ingress_id.length===0||Buffer.byteLength(i.ingress_id)>256||i.now<0||i.expires_at<=i.now||i.expires_at-i.now>600)
  return invalid('invalid proposal identity or bounded lifetime');
 return i;
}
/** Stores a private immutable review proposal only. Producer must separately hold
 * runtime admission and the queue/control target lock. Never starts/cancels jobs. */
export function proposeAbandonment(path:string,value:AbandonmentProposalInput):AbandonmentProposal {
 requireDiscordText(path);const i=input(value);
 return usingExistingStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  checkAbandonmentCompatibility(db,1n);const captured=captureAbandonmentSnapshotIn(db,path,i.job_id,i.ingress_id,true),existing=readOptionalAbandonmentProposalIn(db,i.proposal_id);
  const prior=existing?.proposal.revision??latestAbandonmentRevisionIn(db,i.job_id);
  if(existing===null&&prior===(1n<<63n)-1n)return invalid('proposal revision exhausted');
  const revision=existing===null?prior+1n:prior;
  const review=`Abandon saved request only?\nRequest: ${i.job_id}\nThread: ${captured.target.thread}\nProposal revision: ${revision}\n\nThis one saved request will be permanently cancelled and never replayed.\nThe thread remains held; this does not enable new requests, stop the original execution, withdraw Stop/Archive, unarchive a thread, or cancel published posts or schedules.\nChoose Abandon saved request only or Keep held.\nExpires (host epoch seconds): ${formatRustF64Display(i.expires_at)}`;
  const proposal:AbandonmentProposal=Object.freeze({id:i.proposal_id,revision,job_id:i.job_id,thread_id:captured.target.thread,owner_user_id:captured.target.owner,channel_id:captured.target.channel,
   application_id:i.application_id,created_at_bits:publicationTimeBits(i.now),expires_at_bits:publicationTimeBits(i.expires_at),review_text:review,review_sha256:publicationDigest(review)});
  const stored:StoredAbandonmentProposal={version:1n,proposal,source_ingress:i.ingress_id,snapshot:captured.evidence},encoded=serializeStoredAbandonmentProposal(stored);
  if(Buffer.byteLength(encoded)>MAX_ABANDONMENT_SEAL_BYTES)return invalid('private proposal seal exceeds bound');
  if(existing!==null){if(serializeStoredAbandonmentProposal(existing)!==encoded)return invalid('proposal identity was reused');}
  else if(db.prepare('INSERT INTO cdr_recovery_abandonment_proposals (id,format_version,revision,job_id,target_thread_id,owner_user_id,channel_id,application_id,seal_json,seal_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)')
   .run(proposal.id,1n,revision,proposal.job_id,proposal.thread_id,proposal.owner_user_id,proposal.channel_id,proposal.application_id,encoded,publicationDigest(encoded)).changes!==1)return invalid('proposal was not stored');
  const retained=readAbandonmentProposalIn(db,proposal.id);if(serializeStoredAbandonmentProposal(retained)!==encoded)return invalid('proposal was altered');
  verifyAbandonmentFreshIn(db,path,retained,i.now);return commitStore(proposal);
 }));
}
/** Only confirmed delivery of this exact review can bind a proposal. */
export function bindAbandonmentDelivery(path:string,id:string,message:bigint,bodySha:string,now:number):void {
 for(const s of [path,id,bodySha])requireDiscordText(s);
 if(typeof message!=='bigint'||message<=0n||message>=1n<<63n)return invalid('invalid source message');
 return usingExistingStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  const stored=readAbandonmentProposalIn(db,id);verifyAbandonmentFreshIn(db,path,stored,now);const p=stored.proposal;
  if(p.review_sha256!==bodySha)return invalid('delivered body differs');
  const existing=receiptRow(db,`SELECT revision,message_id,body_sha256,${receiptTextColumns('body_sha256')} FROM cdr_recovery_abandonment_deliveries WHERE proposal_id=?`,id);
  if(existing!==undefined){if(decodeI64(existing.revision,'revision')!==p.revision||decodeI64(existing.message_id,'message_id')!==message||receiptText(existing,'body_sha256')!==bodySha)return invalid('delivery is already bound elsewhere');}
  else if(db.prepare('INSERT INTO cdr_recovery_abandonment_deliveries VALUES(?,?,?,?)').run(id,p.revision,message,bodySha).changes!==1)return invalid('delivery binding was ignored');
  const retained=readDeliveredAbandonmentIn(db,id,p.revision);
  if(retained.message_id!==message||!serdeValueEqual(retained.proposal,p))return invalid('delivery binding was altered');
  verifyAbandonmentFreshIn(db,path,stored,now);return commitStore(undefined);
 }));
}
