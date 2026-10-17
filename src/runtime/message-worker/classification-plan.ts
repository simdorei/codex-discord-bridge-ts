import {planMessage,MessagePlanError,type IncomingMessage,type MessagePlan} from '../message-plan.ts';
export type FrozenMessagePlan={readonly ok:true;readonly value:MessagePlan}|{readonly ok:false;readonly error:MessagePlanError};
export class MessageAdmissionIntegerRangeError extends Error{constructor(){super('Discord identifier does not fit the SQLite integer contract');this.name='MessageAdmissionIntegerRangeError';Object.freeze(this);}}
export function messageSqlId(id:bigint):bigint{if(typeof id!=='bigint'||id<0n||id>=1n<<63n)throw new MessageAdmissionIntegerRangeError();return id;}
export type ClassificationFacts=Omit<IncomingMessage,'mirroredTarget'>;
export function needsNewPromptArm(input:ClassificationFacts,target:string|null):boolean{
 return target===null&&!input.authorIsBot&&!input.content.replace(/^\p{White_Space}+/u,'').startsWith('!')&&input.requiredPlainAskUserIds.length!==0&&!input.mentionedUserIds.some(id=>input.requiredPlainAskUserIds.includes(id));
}
/** Called in both native reader (conditional discard branch) and private owner
 * (exact frozen error/action reconstruction). No execution authority escapes. */
export function frozenMessagePlan(input:ClassificationFacts,target:string|null,arm:string|null):FrozenMessagePlan{
 try{return Object.freeze({ok:true,value:planMessage({...input,mirroredTarget:target!==null||arm!==null})});}
 catch(error){if(!(error instanceof MessagePlanError))throw error;return Object.freeze({ok:false,error});}
}
export function discardClassificationJob(plan:FrozenMessagePlan):string|null{
 return plan.ok&&'Execute'in plan.value&&typeof plan.value.Execute==='object'&&'DiscardRequest'in plan.value.Execute?plan.value.Execute.DiscardRequest.job_id:null;
}
