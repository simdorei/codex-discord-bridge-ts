import {types} from "node:util";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {StateAccessFacade as state} from "../store/state-access-facade.ts";
import type {StoredAsyncQuestion} from "../store/async-question-read.ts";
import {ASYNC_QUESTION_DELIVERY_DOMAIN} from "../store/async-question-delivery-state.ts";
import {asyncChoiceRows,ComponentError,type ActionRowComponent} from "../discord/components.ts";
import {splitExactDeliveryChunks,requireDiscordText} from "../discord/text.ts";
import {sendReceiptChunk,type DiscordReceiptTransport} from "./completion/receipt-sender.ts";
import {CompletionChannelIdError} from "./completion/final-delivery.ts";
import {preparePendingAsyncQuestions} from "./async-question-observation.ts";
export type AsyncQuestionFailureRenderer=(error:unknown)=>string;
function diagnostic(error:unknown,render:AsyncQuestionFailureRenderer):string{
 if(typeof render!=="function"||types.isProxy(render)||types.isAsyncFunction(render)||types.isGeneratorFunction(render))throw new TypeError("Expected public-safe synchronous question diagnostic renderer");
 const message=render(error);if(types.isPromise(message))void Promise.prototype.then.call(message,undefined,()=>undefined);requireDiscordText(message);return message;
}
async function deliverOne(path:string,transport:DiscordReceiptTransport,q:StoredAsyncQuestion):Promise<void>{
 if(q.channelId<=0n||q.channelId>=(1n<<64n))throw new CompletionChannelIdError();
 const send=async(domain:string,key:string,text:string)=>{const chunks=splitExactDeliveryChunks(text,true);for(let i=0;i<chunks.length;i++)await sendReceiptChunk(path,transport,q.channelId,{domain,logicalKey:key,chunkIndex:i,content:chunks[i]!});};
 if(q.body.source_text!=="")await send("async-question-item-text-v1",serializeSerdeValue([q.threadId,q.turnId,q.itemId]),q.body.source_text);
 let body=`질문 ${q.body.index+1n}\n${q.body.title}`;for(let i=0;i<q.body.options.length;i++)body+=`\n${i+1}. ${q.body.options[i]}`;
 let rows:ActionRowComponent[],controls:string;
 try{rows=asyncChoiceRows(q.id,q.body.options);controls=`질문 ${q.body.index+1n}의 답변을 선택하세요.`;}
 catch(error){if(!(error instanceof ComponentError))throw error;rows=[];controls=`질문 ${q.body.index+1n}: 선택 버튼을 만들 수 없습니다 (${error.message}). 자유 입력 또는 1~25개 범위를 벗어난 선택지는 이 버튼 경로에서 지원하지 않습니다. 새 메시지로 답해주세요.`;}
 await send("async-question-body-v1",q.id,body);
 await sendReceiptChunk(path,transport,q.channelId,{domain:ASYNC_QUESTION_DELIVERY_DOMAIN,logicalKey:q.id,chunkIndex:0,content:controls},rows);
 await state.bindAsyncQuestionReceipt(path,q.id,rows.length!==0);
}
/** Original owner + mapping before every question; all body/control chunks use durable
 * identities. Trusted transport still owns actual HTTP and provider receipt validation. */
export async function deliverCheckedAsyncQuestion(path:string,gen:bigint,transport:DiscordReceiptTransport,input:StoredAsyncQuestion,render:AsyncQuestionFailureRenderer):Promise<void>{
 const q=cloneOwnedSerdeValue(input) as StoredAsyncQuestion;if(q.generation<0n||q.generation!==gen||q.state!=="observed")return;
 try{await state.requireCurrentAsyncQuestionMapping(path,q);if(await state.confirmAsyncQuestionOwner(path,q.id))await deliverOne(path,transport,q);}
 catch(error){await state.recordAsyncQuestionError(path,q.id,diagnostic(error,render));throw error;}
}
/** Sequential bounded pending pass; retain the first error but try independent later
 * questions. Shared item context is deduplicated by its original durable receipt. */
export async function deliverPendingAsyncQuestions(path:string,runtime:string,gen:bigint,transport:DiscordReceiptTransport,render:AsyncQuestionFailureRenderer,clock:()=>number=()=>Date.now()/1000):Promise<void>{
 await preparePendingAsyncQuestions(path,runtime,gen,clock);let failed=false,first:unknown;
 for(const q of await state.pendingAsyncQuestions(path,runtime)){try{await deliverCheckedAsyncQuestion(path,gen,transport,q,render);}catch(error){if(!failed){failed=true;first=error;}}}
 if(failed)throw first;
}
