import {parseAsyncQuestions,AsyncQuestionParseError} from "../app-server/async-questions.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../store/state-access-facade.ts";
import {invokeSynchronousVoid} from "../core/synchronous-void.ts";
import {types} from "node:util";
type Store=Pick<IStateAccessFacade,"recordAsyncQuestionObservation"|"reconcileAsyncQuestionObservations"|"retireOldAsyncQuestionOwner"|"compactTerminalAsyncQuestions">;
function generation(v:unknown):asserts v is bigint{if(typeof v!=="bigint"||v<0n||v>=(1n<<63n))throw new AsyncQuestionParseError("invalid question generation");}
function now(clock:()=>number):number{
 if(typeof clock!=="function"||types.isProxy(clock)||types.isAsyncFunction(clock)||types.isGeneratorFunction(clock))throw new TypeError("Expected synchronous question clock");let value:unknown;invokeSynchronousVoid(()=>{value=clock();},{},[]);if(types.isPromise(value))void Promise.prototype.then.call(value,undefined,()=>undefined);if(typeof value!=="number"||!Number.isFinite(value)||value<0)throw new AsyncQuestionParseError("invalid question clock");return value;
}
/** Owning live notification path only. Readonly historical recovery must never use
 * this entry to mint current observations. Each question remains a distinct index. */
export async function observeAsyncQuestionNotification(path:string,runtime:string,gen:bigint,params:unknown,clock:()=>number=()=>Date.now()/1000,state:Store=StateAccessFacade):Promise<void>{
 const parsed=parseAsyncQuestions(params);if(parsed===null)return;generation(gen);const timestamp=now(clock);
 const questions=parsed.questions.length===0?[{title:parsed.text,options:[]}]:parsed.questions,sourceText=parsed.questions.length===0?"":parsed.text;
 for(let index=0;index<questions.length;index++){const q=questions[index]!;await state.recordAsyncQuestionObservation(path,{runtime_id:runtime,generation:gen,thread_id:parsed.threadId,turn_id:parsed.turnId,item_id:parsed.itemId,body:{index:BigInt(index),source_text:sourceText,title:q.title,options:[...q.options]},now:timestamp});}
 await state.reconcileAsyncQuestionObservations(path,runtime,gen);
}
/** Preserve sequential partial-success behavior: retire, reconcile, then compact. */
export async function preparePendingAsyncQuestions(path:string,runtime:string,gen:bigint,clock:()=>number=()=>Date.now()/1000,state:Store=StateAccessFacade):Promise<void>{
 generation(gen);await state.retireOldAsyncQuestionOwner(path,runtime,gen);await state.reconcileAsyncQuestionObservations(path,runtime,gen);await state.compactTerminalAsyncQuestions(path,now(clock));
}
