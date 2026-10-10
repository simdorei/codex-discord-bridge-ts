import type {DatabaseSync} from 'node:sqlite';
import {checkAbandonmentCompatibility,AbandonmentIntegrityError} from './schema-abandonment.ts';
import {receiptRow,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64,decodeOptionalI64} from './sqlite-values.ts';
import {parseStoredAbandonmentProposal,type StoredAbandonmentProposal,type AbandonmentProposal} from './abandonment-codec.ts';
import {publicationDigest,publicationTimeFromBits,validPublicationId} from './publication-codec.ts';
import {abandonmentDatabaseIdentity,captureAbandonmentSnapshotIn} from './abandonment-snapshot.ts';
import {AbandonmentRowMissingError} from './abandonment-identity.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
import {serdeField} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
const invalid=(why:string):never=>{throw new AbandonmentIntegrityError(why);};
export const MAX_ABANDONMENT_SEAL_BYTES=524288;
export function latestAbandonmentRevisionIn(db:DatabaseSync,job:string):bigint {
 requireDiscordText(job);return decodeOptionalI64(receiptRow(db,'SELECT MAX(revision) AS revision FROM cdr_recovery_abandonment_proposals WHERE job_id=?',job)?.revision,'revision')??0n;
}
/** Borrowed bounded read. A historical seal is not fresh disposition authority. */
export function readOptionalAbandonmentProposalIn(db:DatabaseSync,id:string):StoredAbandonmentProposal|null {
 if(!validPublicationId(id))return invalid('invalid proposal identity');
 checkAbandonmentCompatibility(db,1n);
 const row=receiptRow(db,`SELECT seal_json,seal_sha256,format_version,revision,job_id,target_thread_id,owner_user_id,channel_id,application_id,
  ${receiptTextColumns('seal_json','seal_sha256','job_id','target_thread_id')} FROM cdr_recovery_abandonment_proposals WHERE id=? AND length(CAST(seal_json AS BLOB))<=?`,id,BigInt(MAX_ABANDONMENT_SEAL_BYTES));
 if(row===undefined)return null;
 const encoded=receiptText(row,'seal_json')!,hash=receiptText(row,'seal_sha256')!,stored=parseStoredAbandonmentProposal(encoded),p=stored.proposal;
 const created=publicationTimeFromBits(p.created_at_bits),expiry=publicationTimeFromBits(p.expires_at_bits);
 const columns=[decodeI64(row.format_version,'format_version'),decodeI64(row.revision,'revision'),receiptText(row,'job_id'),receiptText(row,'target_thread_id'),decodeI64(row.owner_user_id,'owner'),decodeI64(row.channel_id,'channel'),decodeI64(row.application_id,'application')];
 if(publicationDigest(encoded)!==hash||stored.version!==1n||p.id!==id||p.revision<1n||p.owner_user_id<=0n||p.channel_id<=0n||p.application_id<=0n
  ||!serdeValueEqual(columns,[stored.version,p.revision,p.job_id,p.thread_id,p.owner_user_id,p.channel_id,p.application_id])
  ||publicationDigest(p.review_text)!==p.review_sha256||!Number.isFinite(created)||!Number.isFinite(expiry)||created<0||expiry<=created||expiry-created>600)
  return invalid('stored identity differs from its immutable private seal');
 return stored;
}
export function readAbandonmentProposalIn(db:DatabaseSync,id:string):StoredAbandonmentProposal {
 return readOptionalAbandonmentProposalIn(db,id)??invalid('proposal is missing or oversized');
}
export function requireAbandonmentDatabase(path:string,stored:StoredAbandonmentProposal):void {
 requireDiscordText(path);
 if(serdeField(serdeField(stored.snapshot,'context'),'database')!==abandonmentDatabaseIdentity(path))invalid('proposal belongs to another database installation');
}
/** Requires the caller's active transaction through snapshot capture. Equality is
 * over the parsed Serde evidence, not merely a matching proposal ID or hash. */
export function verifyAbandonmentFreshIn(db:DatabaseSync,path:string,stored:StoredAbandonmentProposal,now:number):void {
 const p=stored.proposal;requireAbandonmentDatabase(path,stored);
 if(typeof now!=='number'||!Number.isFinite(now)||now<publicationTimeFromBits(p.created_at_bits)||now>=publicationTimeFromBits(p.expires_at_bits)
  ||latestAbandonmentRevisionIn(db,p.job_id)!==p.revision
  ||!serdeValueEqual(captureAbandonmentSnapshotIn(db,path,p.job_id,stored.source_ingress,false).evidence,stored.snapshot))
  invalid('proposal expired, superseded or its exact evidence changed');
}
export interface DeliveredAbandonmentProposal {readonly proposal:AbandonmentProposal;readonly message_id:bigint}
export function readDeliveredAbandonmentIn(db:DatabaseSync,id:string,revision:bigint):DeliveredAbandonmentProposal {
 const p=readAbandonmentProposalIn(db,id).proposal;
 const row=receiptRow(db,`SELECT revision,message_id,body_sha256,${receiptTextColumns('body_sha256')} FROM cdr_recovery_abandonment_deliveries WHERE proposal_id=?`,id);
 if(row===undefined)throw new AbandonmentRowMissingError();
 const actual=decodeI64(row.revision,'revision'),message=decodeI64(row.message_id,'message_id'),hash=receiptText(row,'body_sha256');
 if(typeof revision!=='bigint'||revision<1n||p.revision!==revision||actual!==revision||message<=0n||hash!==p.review_sha256)return invalid('displayed proposal identity differs');
 return Object.freeze({proposal:p,message_id:message});
}
export function requireAbandonmentActor(delivered:DeliveredAbandonmentProposal,application:bigint,channel:bigint,actor:bigint,message:bigint):void {
 const p=delivered.proposal;
 if([application,channel,actor,message].some(v=>typeof v!=='bigint'||v<=0n||v>=1n<<63n)
  ||application!==p.application_id||channel!==p.channel_id||actor!==p.owner_user_id||message!==delivered.message_id)
  invalid('authenticated delivery identity differs');
}
