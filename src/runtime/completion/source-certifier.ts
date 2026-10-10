import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import type {AppNotification} from "../../app-server/notification-state.ts";
import {cloneOwnedSerdeValue} from "../../core/owned-serde-value.ts";
import {serializeSerdeValue} from "../../core/serde-json.ts";
import {parseAsyncQuestions,isAsyncAgentMessage} from "../../app-server/async-questions.ts";
import {extractThreadId,extractTurnId} from "../../app-server/identity.ts";
import {serdeField} from "../../app-server/value.ts";
import {parseTurnCompletion,completionJournalPayload,extractCompletedFinalAnswer} from "../../app-server/outcomes.ts";
import {StateAccessFacade as state} from "../../store/state-access-facade.ts";
import {scope as copyScope,OBSERVATION_PAGE_SIZE,type ObservationScope} from "../../store/observation-gap-model.ts";
import type {ObservationEffect} from "../../store/observation-proof.ts";
import {serializeQuestionBody} from "../../store/async-question-body.ts";
import {asyncQuestionOccurrenceId} from "../../store/async-question-observation.ts";
import {observeAsyncQuestionNotification} from "../async-question-observation.ts";
import {observeCompletionTerminal} from "./observation.ts";
import {CompletionHeldError} from "./receipt-sender.ts";
import {QueueIntegerRangeError} from "../queue-runner/errors.ts";
type Server=Pick<PortableResidentLifecycle,"instanceId"|"generation">;
function sequence(v:unknown):bigint{if(typeof v!=="bigint"||v<0n||v>=(1n<<63n))throw new QueueIntegerRangeError();return v;}
/** Only the owning resident's indexed source intake/reconciler may invoke this.
 * Broadcast wakeups, history JSON and caller-provided NoRequiredStore are not proofs.
 * Required journals are written before verifying the matching source sequence. */
export class CompletionSourceCertifier{
 readonly #path:string;readonly #server:Server;readonly #commentary:boolean;readonly #clock:()=>number;
 constructor(path:string,server:Server,commentaryEnabled:boolean,clock:()=>number=()=>Date.now()/1000){if(typeof commentaryEnabled!=="boolean")throw new TypeError("Expected commentary flag");this.#path=path;this.#server=server;this.#commentary=commentaryEnabled;this.#clock=clock;}
 currentScope():ObservationScope{return copyScope({ownerId:this.#server.instanceId,generation:sequence(this.#server.generation())});}
 async certifyEvent(inputScope:ObservationScope,seq:bigint,input:AppNotification):Promise<void>{
  const scope=copyScope(inputScope),notification=cloneOwnedSerdeValue(input) as AppNotification;
  if(typeof notification.method!=="string"||!Object.hasOwn(notification,"params"))throw new TypeError("Expected owned source notification");
  if(scope.ownerId!==this.#server.instanceId||sequence(this.#server.generation())!==scope.generation)throw new CompletionHeldError("original observation scope changed");
  const effects=await this.#journal(scope,notification);
  if(sequence(this.#server.generation())!==scope.generation)throw new CompletionHeldError("observation generation changed during journal");
  // False means effects or gap ownership are still unconfirmed, not permission.
  // The caller checks the durable verified scope before clearing source uncertainty.
  await state.certifyObservation(this.#path,scope,sequence(seq),effects);
 }
 async #journal(scope:ObservationScope,n:AppNotification):Promise<readonly ObservationEffect[]>{
  await observeCompletionTerminal(this.#path,scope.ownerId,{kind:"Notification",generation:scope.generation,notification:n});
  switch(n.method){
   case "turn/completed":{const c=parseTurnCompletion(n.params,false);return [{kind:"Terminal",thread:c.threadId,turn:c.turnId,payload:serializeSerdeValue(completionJournalPayload(c))}];}
   case "turn/started":{const thread=extractThreadId(n.params),turn=extractTurnId(n.params);return thread!==null&&turn!==null?[{kind:"Started",thread,turn}]:[{kind:"Unconfirmed"}];}
   case "item/completed":{
    if(isAsyncAgentMessage(serdeField(n.params,"item"))){
     await observeAsyncQuestionNotification(this.#path,scope.ownerId,scope.generation,n.params,this.#clock);
     const parsed=parseAsyncQuestions(n.params);if(parsed===null)return [{kind:"Unconfirmed"}];
     const questions=parsed.questions.length===0?[{title:parsed.text,options:[]}]:parsed.questions,sourceText=parsed.questions.length===0?"":parsed.text;
     if(questions.length>OBSERVATION_PAGE_SIZE)return [{kind:"Unconfirmed"}];
     return questions.map((q,index)=>({kind:"Question",id:asyncQuestionOccurrenceId(parsed.threadId,parsed.turnId,parsed.itemId,BigInt(index)),thread:parsed.threadId,turn:parsed.turnId,item:parsed.itemId,body:serializeQuestionBody({index:BigInt(index),source_text:sourceText,title:q.title,options:[...q.options]})}));
    }
    const answer=extractCompletedFinalAnswer(n.params);if(answer!==null)return [{kind:"Final",thread:answer.threadId,turn:answer.turnId,content:answer.text}];
    return [{kind:this.#commentary?"Unconfirmed":"NoRequiredStore"}];
   }
   case "thread/goal/updated":return [{kind:"Unconfirmed"}];
   default:return [{kind:this.#commentary&&n.method.startsWith("item/")?"Unconfirmed":"NoRequiredStore"}];
  }
 }
}
