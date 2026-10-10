import type {DatabaseSync} from 'node:sqlite';
import {usingInitializedStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {readPublicationProposalIn,verifyPublicationFreshIn,invalidPublication} from './publication-proposal.ts';
import {publicationTimeBits,type PublicationProposal,type StoredPublicationProposal} from './publication-codec.ts';
import {PublicationRowMissingError} from './publication-snapshot.ts';
import {receiptRow,receiptText,receiptTextColumns,receiptExists} from './delivery-receipt-key.ts';
import {decodeI64,decodeOptionalI64} from './sqlite-values.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
import {serdeField,rustTrim} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
export type PublicationDecision='ApproveExact'|'KeepHeld';
export interface PublicationConsentInput{readonly proposal_id:string;readonly revision:bigint;readonly ingress_id:string;readonly now:number}
/** Durable intent evidence only; not convertible to a dispatch/publisher permit. */
export interface PublicationDecisionReceipt{readonly decision:PublicationDecision;readonly original_ingress_id:string;readonly original_interaction_id:bigint;readonly already_recorded:boolean}
interface Click{event:bigint;decision:PublicationDecision;identity:unknown}
function receiptIn(db:DatabaseSync,id:string):PublicationDecisionReceipt|null{
 const row=receiptRow(db,`SELECT d.decision,d.ingress_id,d.interaction_id,CAST(d.decision AS BLOB) AS raw_decision,CAST(d.ingress_id AS BLOB) AS raw_ingress_id,(SELECT encoding FROM pragma_encoding) AS encoding FROM cdr_recovery_publication_decisions d JOIN cdr_recovery_publication_proposals p ON p.id=d.proposal_id AND p.revision=d.revision WHERE d.proposal_id=?`,id);if(row===undefined)return null;
 const raw=receiptText(row,'decision'),ingress=receiptText(row,'ingress_id')!,event=decodeI64(row.interaction_id,'interaction_id');const decision=raw==='approve_exact'?'ApproveExact':raw==='keep_held'?'KeepHeld':invalidPublication('unsupported stored publication decision');return Object.freeze({decision,original_ingress_id:ingress,original_interaction_id:event,already_recorded:true});
}
function clickIn(db:DatabaseSync,input:PublicationConsentInput,p:PublicationProposal):Click{
 const row=receiptRow(db,`SELECT version,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,target_thread_id,state,phase,runtime_id,owner_kind,owner_id,payload_json,${receiptTextColumns('kind','target_thread_id','state','phase','runtime_id','owner_kind','owner_id','payload_json')} FROM discord_ingress_journal WHERE ingress_id=? AND length(CAST(payload_json AS BLOB))<=131072`,input.ingress_id);if(row===undefined)throw new PublicationRowMissingError();
 const headers={version:decodeI64(row.version,'version'),kind:receiptText(row,'kind'),event:decodeOptionalI64(row.event_id,'event'),app:decodeOptionalI64(row.application_id,'app'),channel:decodeI64(row.channel_id,'channel'),owner:decodeI64(row.owner_user_id,'owner'),message:decodeOptionalI64(row.source_message_id,'message'),target:receiptText(row,'target_thread_id',true),state:receiptText(row,'state'),phase:receiptText(row,'phase'),runtime:receiptText(row,'runtime_id',true),owner_kind:receiptText(row,'owner_kind',true),owner_id:receiptText(row,'owner_id',true)};
 const raw=receiptText(row,'payload_json')!;
 const delivered=receiptRow(db,'SELECT message_id FROM cdr_recovery_publication_deliveries WHERE proposal_id=? AND revision=? AND body_sha256=?',p.id,p.revision,p.review_sha256);if(delivered===undefined)throw new PublicationRowMissingError();const message=decodeI64(delivered.message_id,'message_id');
 const payload=parseSerdeValue(raw),work=serdeField(payload,'work'),body=serdeField(serdeField(work,'Component'),'RecoveryPublicationDecision'),value=serdeField(body,'decision');
 const decision:PublicationDecision=value==='ApproveExact'||value==='KeepHeld'?value:invalidPublication('not an exact publication decision component');
 if(headers.version!==1n||headers.kind!=='interaction'||headers.event===null||headers.event<=0n||headers.app!==p.application_id||headers.channel!==p.channel_id||headers.owner!==p.owner_user_id||headers.message!==message||headers.target!==p.thread_id||serdeField(payload,'version')!==1n||!serdeValueEqual(work,{Component:{RecoveryPublicationDecision:{proposal_id:p.id,revision:p.revision,decision}}})||headers.runtime===null||rustTrim(headers.runtime)==='')return invalidPublication('actor, application, source message or component binding changed');
 const existing=receiptIn(db,p.id),exact=existing!==null&&existing.original_ingress_id===input.ingress_id&&existing.original_interaction_id===headers.event&&existing.decision===decision;
 if(!exact&&(headers.state!=='executing'||headers.phase!=='processing'||headers.owner_kind!==null||headers.owner_id!==null))return invalidPublication('interaction has no current unowned execution custody');return {event:headers.event,decision,identity:{headers,payload}};
}
function existingReceipt(db:DatabaseSync,input:PublicationConsentInput,stored:StoredPublicationProposal,click:Click):PublicationDecisionReceipt|null{
 const receipt=receiptIn(db,input.proposal_id);if(receipt===null)return null;if(receipt.decision!==click.decision)return invalidPublication('decision already recorded; no conflicting overwrite');if(receipt.original_ingress_id!==input.ingress_id||receipt.original_interaction_id!==click.event)verifyPublicationFreshIn(db,stored,input.now);return receipt;
}
/** Rechecks the durable authenticated ingress. Exact completed replay can read
 * its original receipt after expiry; a new click still requires live custody and
 * fresh evidence. This function never starts work or releases an existing hold. */
export function recordPublicationConsent(path:string,value:PublicationConsentInput):Promise<PublicationDecisionReceipt>{
 requireDiscordText(path);const id=serdeField(value,'proposal_id'),revision=serdeField(value,'revision'),ingress=serdeField(value,'ingress_id'),now=serdeField(value,'now');requireDiscordText(id);requireDiscordText(ingress);if(typeof revision!=='bigint'||revision<-(1n<<63n)||revision>=1n<<63n||typeof now!=='number')throw new TypeError('Expected publication consent i64 revision and f64 clock');const input={proposal_id:id,revision,ingress_id:ingress,now};
 return usingInitializedStore(path,db=>withStoreTransaction(db,'IMMEDIATE',()=>{
  const stored=readPublicationProposalIn(db,id);if(stored.proposal.revision!==revision)return invalidPublication('component revision differs from stored proposal');const click=clickIn(db,input,stored.proposal),existing=existingReceipt(db,input,stored,click);if(existing!==null)return commitStore(existing);
  verifyPublicationFreshIn(db,stored,now);const bits=publicationTimeBits(now).toString();db.prepare('INSERT INTO cdr_recovery_publication_decisions (proposal_id,revision,ingress_id,interaction_id,decision,recorded_at_bits) VALUES(?,?,?,?,?,?)').run(id,revision,ingress,click.event,click.decision==='ApproveExact'?'approve_exact':'keep_held',bits);
  const receipt=receiptIn(db,id);if(receipt===null)return invalidPublication('decision insert was ignored');const exact=receiptExists(db,'SELECT EXISTS(SELECT 1 FROM cdr_recovery_publication_decisions WHERE proposal_id=? AND revision=? AND recorded_at_bits=?) AS held',id,revision,bits);
  if(!exact||receipt.original_ingress_id!==ingress||receipt.original_interaction_id!==click.event||receipt.decision!==click.decision)return invalidPublication('decision insert was altered');verifyPublicationFreshIn(db,stored,now);if(!serdeValueEqual(clickIn(db,input,stored.proposal).identity,click.identity))return invalidPublication('interaction changed during decision commit');return commitStore(Object.freeze({...receipt,already_recorded:false}));
 }));
}
