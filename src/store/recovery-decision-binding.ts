import type {DatabaseSync} from 'node:sqlite';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {parseComponentId} from '../discord/components.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
import {serdeField} from '../app-server/value.ts';
import {parseStoredPublicationProposal,serializeStoredPublicationProposal,type PublicationProposal} from './publication-codec.ts';
import {parseStoredAbandonmentProposal,serializeStoredAbandonmentProposal} from './abandonment-codec.ts';
import {getIngressIn,type StoredIngress} from './ingress-read.ts';
import {receiptExists} from './delivery-receipt-key.ts';
export type RecoveryDecisionFlow='Publication'|'Abandonment';
export interface RecoveryDecisionClick {
 readonly flow:RecoveryDecisionFlow;readonly decision:'ApproveExact'|'AbandonOnly'|'KeepHeld';readonly proposalId:string;readonly revision:bigint;
 readonly interactionIngressId:string;readonly interactionId:bigint;readonly applicationId:bigint;readonly actorId:bigint;readonly channelId:bigint;
 readonly sourceMessageId:bigint;readonly customId:string;readonly processingMode:'Execute';
}
export interface RecoveryDecisionSnapshot {readonly sealJson:string;readonly displayedJson:string;readonly proposal:PublicationProposal;readonly messageId:bigint}
export function recoveryText(value:unknown,max:number):asserts value is string {requireDiscordText(value);if(Buffer.byteLength(value)>max)throw new RangeError('Recovery decision exceeds native text boundary');}
function positive(value:unknown):asserts value is bigint {if(typeof value!=='bigint'||value<=0n||value>=1n<<63n)throw new TypeError('Expected original positive i64 recovery identity');}
/** Passive original click, including canonical ingress and custom ID. No class or callback crosses the worker boundary. */
export function captureRecoveryDecisionClick(input:unknown):RecoveryDecisionClick {
 const interactionIngressId=own(input,'interactionIngressId'),interactionId=own(input,'interactionId'),applicationId=own(input,'applicationId'),actorId=own(input,'actorId'),channelId=own(input,'channelId'),sourceMessageId=own(input,'sourceMessageId'),customId=own(input,'customId'),processingMode=own(input,'processingMode');
 positive(interactionId);positive(applicationId);positive(actorId);positive(channelId);positive(sourceMessageId);recoveryText(interactionIngressId,64);recoveryText(customId,400);
 const component=parseComponentId(customId);if(component===null||!('RecoveryPublicationDecision'in component||'RecoveryAbandonDecision'in component)||processingMode!=='Execute'||interactionIngressId!==`interaction:${interactionId}`)throw new TypeError('Expected canonical original recovery click');
 const flow='RecoveryPublicationDecision'in component?'Publication':'Abandonment',body='RecoveryPublicationDecision'in component?component.RecoveryPublicationDecision:component.RecoveryAbandonDecision;
 return Object.freeze({flow,decision:body.decision,proposalId:body.proposal_id,revision:body.revision,interactionIngressId,interactionId,applicationId,actorId,channelId,sourceMessageId,customId,processingMode});
}
export function recoverySnapshot(flow:RecoveryDecisionFlow,sealJson:string,displayedJson:string):RecoveryDecisionSnapshot {
 recoveryText(sealJson,524288);recoveryText(displayedJson,65536);
 const stored=flow==='Publication'?parseStoredPublicationProposal(sealJson):parseStoredAbandonmentProposal(sealJson);
 const encoded=flow==='Publication'?serializeStoredPublicationProposal(stored as ReturnType<typeof parseStoredPublicationProposal>):serializeStoredAbandonmentProposal(stored as ReturnType<typeof parseStoredAbandonmentProposal>);
 const displayed=parseSerdeValue(displayedJson),message=serdeField(displayed,'message_id');positive(message);
 if(encoded!==sealJson||serializeSerdeValue({proposal:stored.proposal,message_id:message})!==displayedJson)throw new TypeError('Noncanonical recovery proposal or displayed seal');
 return Object.freeze({sealJson,displayedJson,proposal:stored.proposal,messageId:message});
}
export function requireRecoverySnapshot(click:RecoveryDecisionClick,snapshot:RecoveryDecisionSnapshot):void {
 const p=snapshot.proposal;if(p.id!==click.proposalId||p.revision!==click.revision||p.application_id!==click.applicationId||p.owner_user_id!==click.actorId||p.channel_id!==click.channelId||snapshot.messageId!==click.sourceMessageId)throw new TypeError('Original recovery click differs from displayed proposal');
}
export function requireRecoveryIngress(click:RecoveryDecisionClick,snapshot:RecoveryDecisionSnapshot,saved:StoredIngress|null):void {
 requireRecoverySnapshot(click,snapshot);
 if(saved===null||saved.ingressId!==click.interactionIngressId||saved.kind!=='interaction'||saved.eventId!==click.interactionId||saved.applicationId!==click.applicationId||saved.channelId!==click.channelId||saved.ownerUserId!==click.actorId||saved.sourceMessageId!==click.sourceMessageId||saved.targetThreadId!==snapshot.proposal.thread_id||!serdeValueEqual(serdeField(saved.payload,'work'),{Component:parseComponentId(click.customId)}))throw new TypeError('Recovery click differs from original durable ingress');
}
/** Called INSIDE the original mutation transaction before any write. The original
 * seal and displayed bytes, not the request ACK, bind the transaction authority. */
export function requireRecoveryDecisionIn(db:DatabaseSync,click:RecoveryDecisionClick,expected:RecoveryDecisionSnapshot,current:RecoveryDecisionSnapshot):void {
 if(expected.sealJson!==current.sealJson||expected.displayedJson!==current.displayedJson)throw new TypeError('Original displayed recovery seal changed');
 if(!receiptExists(db,'SELECT EXISTS(SELECT 1 FROM discord_ingress_journal WHERE ingress_id=? AND length(CAST(payload_json AS BLOB))<=131072) AS held',click.interactionIngressId))throw new TypeError('Original recovery ingress missing or oversized');
 requireRecoveryIngress(click,current,getIngressIn(db,click.interactionIngressId));
}
