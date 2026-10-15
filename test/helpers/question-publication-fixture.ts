import type {DatabaseSync} from 'node:sqlite';
import {queueJob} from './queue-job.ts';
import {usingInitializedStore} from '../../src/store/owned-scope.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {observeAsyncQuestionNotification} from '../../src/runtime/async-question-observation.ts';
export const questionDiagnostic=()=> 'public-safe question delivery failed';
export async function seedPublication(path:string,input:{runtime?:string;context?:string;questions?:{title:string;options:string[]}[]}={}){
 await state.enqueue(path,queueJob({ownerUserId:2n}));const claim=(await state.tryBeginAttempt(path,'saved',[],1n))!;await state.markRunningIfClaimed(path,claim,'turn');
 await usingInitializedStore(path,db=>db.exec("INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES('target','p','t',10,1,0)"));
 await observeAsyncQuestionNotification(path,input.runtime??'runtime',1n,{threadId:'target',turnId:'turn',item:{id:'item',type:'agentMessage',delivery:'async',text:input.context??'shared context',questions:input.questions??[{title:'Q0',options:['yes']},{title:'Q1',options:['no']}]}},()=>1);
 return state.pendingAsyncQuestions(path,input.runtime??'runtime');
}
export const editPublication=(path:string,edit:(db:DatabaseSync)=>void)=>usingInitializedStore(path,edit);
export const publicationReceipts=(path:string)=>usingInitializedStore(path,db=>db.prepare('SELECT receipt_key,content_hash,message_id,retryable,blocked_reason FROM codex_delivery_receipts ORDER BY receipt_key').all());
