import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {parseComponentId} from '../../discord/components.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
import {decodeQuestionBody} from '../../store/async-question-body.ts';
import type {StoredAsyncQuestion} from '../../store/async-question-read.ts';
import type {AsyncQuestionDispatchClaim} from '../../store/async-question-dispatch.ts';
export const ASYNC_CHOICE_REQUEST_BYTES=1048576,ASYNC_CHOICE_REPLY_BYTES=1048576;
export type AsyncChoiceOperation='Get'|'Mapping'|'Begin'|'Guard'|'Confirm'|'Reject'|'Error';
export interface AsyncChoiceClick{
 readonly interactionIngressId:string;readonly interactionId:bigint;readonly applicationId:bigint;
 readonly actorId:bigint;readonly channelId:bigint;readonly sourceMessageId:bigint|null;readonly customId:string;
 readonly questionId:string;readonly option:bigint;readonly processingMode:'Execute'|'ConfirmationOnly';
}
function text(value:unknown,max=393216):asserts value is string{requireDiscordText(value);if(Buffer.byteLength(value)>max)throw new RangeError('AsyncChoice text exceeds native boundary');}
function unsigned(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<=0n||value>=1n<<64n)throw new TypeError('Expected original positive u64 AsyncChoice identity');}
function signed(value:unknown):asserts value is bigint{if(typeof value!=='bigint'||value<-(1n<<63n)||value>=1n<<63n)throw new TypeError('Expected original i64 question identity');}
export function captureAsyncChoiceClick(input:unknown):AsyncChoiceClick{
 const interactionIngressId=own(input,'interactionIngressId'),interactionId=own(input,'interactionId'),applicationId=own(input,'applicationId'),actorId=own(input,'actorId'),channelId=own(input,'channelId'),sourceMessageId=own(input,'sourceMessageId'),customId=own(input,'customId'),processingMode=own(input,'processingMode');
 unsigned(interactionId);unsigned(applicationId);unsigned(actorId);unsigned(channelId);if(sourceMessageId!==null)unsigned(sourceMessageId);text(interactionIngressId,64);text(customId,400);
 if(interactionIngressId!==`interaction:${interactionId}`||(processingMode!=='Execute'&&processingMode!=='ConfirmationOnly'))throw new TypeError('Expected original AsyncChoice click');
 const component=parseComponentId(customId);if(component===null||!('AsyncChoice'in component))throw new TypeError('Expected exact AsyncChoice component');
 return Object.freeze({interactionIngressId,interactionId,applicationId,actorId,channelId,sourceMessageId,customId,questionId:component.AsyncChoice.question_id,option:component.AsyncChoice.option,processingMode});
}
/** Bounded immutable row decoding preserves exact bigint and question bytes. */
export function snapshotAsyncChoiceQuestion(input:unknown):StoredAsyncQuestion{
 const q=cloneOwnedSerdeValue(input) as StoredAsyncQuestion;
 const strings=['id','runtimeId','threadId','turnId','itemId','originJobId','state','error'] as const;
 if(q===null||typeof q!=='object'||Object.keys(q).length!==15)throw new TypeError('Expected exact question snapshot');
 for(const k of strings)text(q[k]);for(const k of ['generation','channelId','ownerUserId'] as const)signed(q[k]);
 for(const k of ['messageId','replyJobId'] as const)if(q[k]!==null)text(q[k]);
 if(q.chosen!==null&&(typeof q.chosen!=='bigint'||q.chosen<0n||q.chosen>65535n))throw new TypeError('Expected u16 chosen option');
 const body=decodeQuestionBody(serializeSerdeValue(q.body));Object.freeze(body.options);Object.freeze(body);
 const result=Object.freeze({...q,body});text(serializeSerdeValue(result));return result;
}
export function parseAsyncChoiceQuestion(json:string):StoredAsyncQuestion{text(json);const q=snapshotAsyncChoiceQuestion(parseSerdeValue(json));if(serializeSerdeValue(q)!==json)throw new TypeError('Noncanonical question bytes');return q;}
export function parseAsyncChoiceClaim(json:string):AsyncQuestionDispatchClaim{
 text(json);const c=cloneOwnedSerdeValue(parseSerdeValue(json)) as AsyncQuestionDispatchClaim;
 if(c===null||typeof c!=='object'||Object.keys(c).length!==11)throw new TypeError('Expected exact AsyncChoice dispatch claim');
 for(const k of ['id','runtime_id','message','prompt'] as const)text(c[k]);for(const k of ['generation','channel','actor'] as const)signed(c[k]);
 if(typeof c.option!=='bigint'||c.option<0n||c.option>=1n<<64n||typeof c.now!=='number'||!Number.isFinite(c.now)||c.now<0||(c.mode!=='Start'&&c.mode!=='Steer')||!Array.isArray(c.baseline_turn_ids))throw new TypeError('Invalid AsyncChoice dispatch claim');
 for(const id of c.baseline_turn_ids)text(id);if(serializeSerdeValue(c)!==json)throw new TypeError('Noncanonical dispatch bytes');return Object.freeze(c);
}
export function asyncChoiceBinding(id:string,path:string,operation:AsyncChoiceOperation,click:AsyncChoiceClick,questionJson:string|null,claimJson:string|null,detail:string|null){
 text(path,32768);if(path.includes('\0')||typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id)||!['Get','Mapping','Begin','Guard','Confirm','Reject','Error'].includes(operation))throw new TypeError('Invalid native AsyncChoice operation');
 const q=questionJson===null?null:parseAsyncChoiceQuestion(questionJson);
 if(q!==null&&q.id!==click.questionId)throw new TypeError('Crossed original question');
 if(operation!=='Get'&&q===null)throw new TypeError('Question occurrence required');
 if(operation==='Begin'){
  if(click.processingMode!=='Execute'||claimJson===null)throw new TypeError('Execute claim required');const c=parseAsyncChoiceClaim(claimJson);
  if(q===null||c.id!==q.id||c.runtime_id!==q.runtimeId||c.generation!==q.generation||c.channel!==click.channelId||c.actor!==click.actorId||c.message!==String(click.sourceMessageId)||c.option!==click.option)throw new TypeError('Crossed AsyncChoice claim');
 }else if(claimJson!==null)throw new TypeError('Unexpected dispatch claim');
 if(operation==='Confirm'||operation==='Reject'||operation==='Error'){text(detail);if(operation!=='Confirm'&&Array.from(detail).length>1000)throw new RangeError('Unbounded question error');}else if(detail!==null)throw new TypeError('Unexpected completion detail');
 return Object.freeze({id,path,operation,...click,questionJson,claimJson,detail});
}
