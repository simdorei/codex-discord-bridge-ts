import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {parseAbandonmentDecisionReceipt,serializeAbandonmentDecisionReceipt,type AbandonmentDecisionReceipt} from '../../store/abandonment-codec.ts';
import type {PublicationDecisionReceipt} from '../../store/publication-consent.ts';
import {captureRecoveryDecisionClick,recoverySnapshot,recoveryText,requireRecoverySnapshot,type RecoveryDecisionClick,type RecoveryDecisionSnapshot} from '../../store/recovery-decision-binding.ts';
// Canonical seal/display JSON contains no raw control characters: quoting is at
// most 2x. A repeated Read carries 2(S+D) in its echoed binding and 4(S+D)
// in its encoded result. With S=524288,D=65536, that is 3538944 bytes; the
// remaining 655360 bytes cover the path (at most 6*32768), identities and keys.
export const RECOVERY_DECISION_REQUEST_BYTES=2097152,RECOVERY_DECISION_REPLY_BYTES=4194304;
export type RecoveryDecisionOperation='Read'|'Ingress'|'Decide'|'Recover';
export type RecoveryDecisionReceipt=PublicationDecisionReceipt|AbandonmentDecisionReceipt;
export function recoveryDecisionBinding(id:string,path:string,operation:RecoveryDecisionOperation,input:RecoveryDecisionClick,sealJson:string|null,displayedJson:string|null,now:number) {
 recoveryText(path,32768);if(path.includes('\0')||typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)||!['Read','Ingress','Decide','Recover'].includes(operation)||typeof now!=='number'||!Number.isFinite(now)||now<0)throw new TypeError('Invalid recovery native operation');
 const click=captureRecoveryDecisionClick(input);if(sealJson===null||displayedJson===null){if(sealJson!==null||displayedJson!==null||operation!=='Read')throw new TypeError('Original recovery seal required');}else requireRecoverySnapshot(click,recoverySnapshot(click.flow,sealJson,displayedJson));
 return Object.freeze({id,path,operation,...click,sealJson,displayedJson,now});
}
export function encodeRecoverySnapshot(snapshot:RecoveryDecisionSnapshot):string{return serializeSerdeValue({sealJson:snapshot.sealJson,displayedJson:snapshot.displayedJson});}
export function parseRecoverySnapshot(raw:unknown,click:RecoveryDecisionClick):RecoveryDecisionSnapshot {
 recoveryText(raw,2097152);const value=parseSerdeValue(raw),seal=own(value,'sealJson'),display=own(value,'displayedJson');recoveryText(seal,524288);recoveryText(display,65536);
 if(serializeSerdeValue({sealJson:seal,displayedJson:display})!==raw)throw new TypeError('Noncanonical recovery snapshot');const snapshot=recoverySnapshot(click.flow,seal,display);requireRecoverySnapshot(click,snapshot);return snapshot;
}
export function encodeRecoveryReceipt(click:RecoveryDecisionClick,value:RecoveryDecisionReceipt):string {return click.flow==='Abandonment'?serializeAbandonmentDecisionReceipt(value as AbandonmentDecisionReceipt):serializeSerdeValue(value);}
export function parseRecoveryReceipt(raw:unknown,click:RecoveryDecisionClick,snapshot:RecoveryDecisionSnapshot,exact:boolean):RecoveryDecisionReceipt {
 recoveryText(raw,65536);
 if(click.flow==='Abandonment'){
  const value=parseAbandonmentDecisionReceipt(raw);if(serializeAbandonmentDecisionReceipt(value)!==raw||value.proposal_id!==click.proposalId||value.revision!==click.revision||value.thread_id!==snapshot.proposal.thread_id||value.job_id!==snapshot.proposal.job_id||value.ingress_id!==click.interactionIngressId||value.interaction_id!==click.interactionId||value.decision!==click.decision)throw new TypeError('Crossed abandonment receipt');return Object.freeze(value);
 }
 const value=parseSerdeValue(raw),decision=own(value,'decision'),ingress=own(value,'original_ingress_id'),event=own(value,'original_interaction_id'),recorded=own(value,'already_recorded');
 recoveryText(ingress,64);if(typeof event!=='bigint'||event<=0n||event>=1n<<63n||ingress!==`interaction:${event}`||typeof recorded!=='boolean'||decision!==click.decision||(decision!=='ApproveExact'&&decision!=='KeepHeld'))throw new TypeError('Invalid publication receipt');
 const receipt=Object.freeze({decision,original_ingress_id:ingress,original_interaction_id:event,already_recorded:recorded});
 if(serializeSerdeValue(receipt)!==raw||((exact||!recorded)&&(ingress!==click.interactionIngressId||event!==click.interactionId)))throw new TypeError('Crossed original publication receipt');return receipt;
}
