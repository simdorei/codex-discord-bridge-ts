import type {DatabaseSync} from 'node:sqlite';
import {usingInitializedStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {PublicationConsentIntegrityError,checkPublicationConsentCompatibility,FORMAT_VERSION} from './schema-publication-consent.ts';
import {capturePublicationSnapshotIn,PublicationRowMissingError} from './publication-snapshot.ts';
import {receiptRow,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64,decodeOptionalI64} from './sqlite-values.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {rustTrim,serdeField,serdeObject} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {parseStoredPublicationProposal,serializeStoredPublicationProposal,publicationDigest,publicationTimeBits,publicationTimeFromBits,validPublicationId,type PublicationProposal,type StoredPublicationProposal} from './publication-codec.ts';
export interface PublicationProposalInput {readonly proposal_id:string;readonly job_id:string;readonly application_id:bigint;readonly review_text:string;readonly review_context:unknown;readonly now:number;readonly expires_at:number}
const MAX_SEAL_BYTES=524288;
export const invalidPublication=(reason:string):never=>{throw new PublicationConsentIntegrityError(reason);};
function input(value:PublicationProposalInput):PublicationProposalInput{
 const rawNow=serdeField(value,'now'),rawExpires=serdeField(value,'expires_at');
 if(typeof rawNow!=='number'||typeof rawExpires!=='number'||!Number.isFinite(rawNow)||!Number.isFinite(rawExpires))return invalidPublication('invalid or unbounded proposal identity, review or lifetime');
 const copy=cloneOwnedSerdeValue(value),id=serdeField(copy,'proposal_id'),job=serdeField(copy,'job_id'),app=serdeField(copy,'application_id'),review=serdeField(copy,'review_text'),context=serdeField(copy,'review_context'),now=serdeField(copy,'now'),expires=serdeField(copy,'expires_at');
 if(typeof id!=='string'||!validPublicationId(id)||typeof job!=='string'||rustTrim(job)===''||Buffer.byteLength(job)>128||typeof app!=='bigint'||app<=0n||app>=1n<<63n||typeof review!=='string'||rustTrim(review)===''||Buffer.byteLength(review)>8000||!serdeObject(context)||Buffer.byteLength(serializeSerdeValue(context))>65536||typeof now!=='number'||typeof expires!=='number'||!Number.isFinite(now)||!Number.isFinite(expires)||now<0||expires<=now||expires-now>600)return invalidPublication('invalid or unbounded proposal identity, review or lifetime');
 return {proposal_id:id,job_id:job,application_id:app,review_text:review,review_context:context,now,expires_at:expires};
}
export function latestPublicationRevisionIn(db:DatabaseSync,job:string):bigint{return decodeOptionalI64(receiptRow(db,'SELECT MAX(revision) AS revision FROM cdr_recovery_publication_proposals WHERE job_id=?',job)?.revision,'proposal revision')??0n;}
export function readOptionalPublicationProposalIn(db:DatabaseSync,id:string):StoredPublicationProposal|null{
 checkPublicationConsentCompatibility(db,FORMAT_VERSION);
 const row=receiptRow(db,`SELECT seal_json,seal_sha256,format_version,revision,job_id,target_thread_id,owner_user_id,channel_id,application_id,${receiptTextColumns('seal_json','seal_sha256','job_id','target_thread_id')} FROM cdr_recovery_publication_proposals WHERE id=? AND length(CAST(seal_json AS BLOB))<=?`,id,BigInt(MAX_SEAL_BYTES));
 if(row===undefined)return null;
 const encoded=receiptText(row,'seal_json')!,sha=receiptText(row,'seal_sha256')!,columns=[decodeI64(row.format_version,'format_version'),decodeI64(row.revision,'revision'),receiptText(row,'job_id')!,receiptText(row,'target_thread_id')!,decodeI64(row.owner_user_id,'owner'),decodeI64(row.channel_id,'channel'),decodeI64(row.application_id,'application')];
 const stored=parseStoredPublicationProposal(encoded),p=stored.proposal;
 if(publicationDigest(encoded)!==sha||stored.version!==FORMAT_VERSION||p.id!==id||!serdeValueEqual(columns,[stored.version,p.revision,p.job_id,p.thread_id,p.owner_user_id,p.channel_id,p.application_id])||p.review_sha256!==publicationDigest(p.review_text))return invalidPublication('stored proposal identity differs from its immutable seal');return stored;
}
export function readPublicationProposalIn(db:DatabaseSync,id:string):StoredPublicationProposal{return readOptionalPublicationProposalIn(db,id)??invalidPublication('proposal is missing or oversized');}
export function verifyPublicationFreshIn(db:DatabaseSync,stored:StoredPublicationProposal,now:number):void{
 checkPublicationConsentCompatibility(db,FORMAT_VERSION);const p=stored.proposal;
 if(typeof now!=='number'||!Number.isFinite(now)||now<publicationTimeFromBits(p.created_at_bits)||now>=publicationTimeFromBits(p.expires_at_bits)||latestPublicationRevisionIn(db,p.job_id)!==p.revision||!serdeValueEqual(capturePublicationSnapshotIn(db,p.job_id).seal,stored.snapshot))invalidPublication('proposal expired, superseded or its local evidence changed');
}
/** Immutable descriptive intent only. Does not consume Pending or grant a native
 * RPC/publisher permit. Repeats must match the typed canonical stored seal. */
export function proposePublication(path:string,value:PublicationProposalInput):Promise<PublicationProposal>{
 requireDiscordText(path);const i=input(value);
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  checkPublicationConsentCompatibility(db,FORMAT_VERSION);const captured=capturePublicationSnapshotIn(db,i.job_id),existing=readOptionalPublicationProposalIn(db,i.proposal_id);
  const prior=existing?.proposal.revision??latestPublicationRevisionIn(db,i.job_id);if(existing===null&&prior===(1n<<63n)-1n)return invalidPublication('proposal revision exhausted');const revision=existing===null?prior+1n:prior;
  const proposal=Object.freeze({id:i.proposal_id,revision,job_id:i.job_id,thread_id:captured.thread,owner_user_id:captured.owner,channel_id:captured.channel,application_id:i.application_id,created_at_bits:publicationTimeBits(i.now),expires_at_bits:publicationTimeBits(i.expires_at),review_text:i.review_text,review_sha256:publicationDigest(i.review_text)});
  const stored:StoredPublicationProposal={version:FORMAT_VERSION,proposal,snapshot:captured.seal,review_context:i.review_context},encoded=serializeStoredPublicationProposal(stored);
  if(Buffer.byteLength(encoded)>MAX_SEAL_BYTES)return invalidPublication('proposal seal exceeds bound');
  if(existing!==null){if(serializeStoredPublicationProposal(existing)!==encoded)return invalidPublication('producer identity reused with different proposal');}
  else db.prepare('INSERT INTO cdr_recovery_publication_proposals (id,format_version,revision,job_id,target_thread_id,owner_user_id,channel_id,application_id,seal_json,seal_sha256) VALUES(?,?,?,?,?,?,?,?,?,?)').run(proposal.id,FORMAT_VERSION,revision,proposal.job_id,proposal.thread_id,proposal.owner_user_id,proposal.channel_id,proposal.application_id,encoded,publicationDigest(encoded));
  const retained=readPublicationProposalIn(db,proposal.id);
  if(serializeStoredPublicationProposal(retained)!==encoded)return invalidPublication('proposal insert was lost or altered');verifyPublicationFreshIn(db,retained,i.now);return commitStore(proposal);
 }));
}
/** Called only after confirmed exact review delivery. Unknown HTTP cannot bind. */
export function bindPublicationDelivery(path:string,id:string,message:bigint,bodySha:string,now:number):Promise<void>{
 for(const value of [path,id,bodySha])requireDiscordText(value);if(typeof message!=='bigint'||message<=0n||message>=1n<<63n)return invalidPublication('invalid proposal message identity');
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  const stored=readPublicationProposalIn(db,id);verifyPublicationFreshIn(db,stored,now);const p=stored.proposal;if(p.review_sha256!==bodySha)return invalidPublication('delivered review text differs');
  db.prepare('INSERT OR IGNORE INTO cdr_recovery_publication_deliveries (proposal_id,revision,message_id,body_sha256) VALUES(?,?,?,?)').run(id,p.revision,message,bodySha);
  const row=receiptRow(db,`SELECT revision,message_id,body_sha256,${receiptTextColumns('body_sha256')} FROM cdr_recovery_publication_deliveries WHERE proposal_id=?`,id);if(row===undefined)throw new PublicationRowMissingError();
  if(decodeI64(row.revision,'revision')!==p.revision||decodeI64(row.message_id,'message')!==message||receiptText(row,'body_sha256')!==bodySha)return invalidPublication('delivery was lost, altered or already bound elsewhere');
  verifyPublicationFreshIn(db,stored,now);return commitStore(undefined);
 }));
}
