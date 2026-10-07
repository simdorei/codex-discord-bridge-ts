import {types} from "node:util";
import {I64_MIN,I64_MAX} from "../protocol/ids.ts";
export type TurnStatus="Completed"|"Interrupted"|"Failed"|"InProgress";
export type InterruptOrigin="RemoteUserIntent"|"ExternalOrUnknown";
export interface TurnCompletion{readonly threadId:string;readonly turnId:string;readonly status:TurnStatus;readonly errorMessage:string;readonly interruptOrigin:InterruptOrigin|null;readonly durationMs:bigint|null;readonly usageLimit:boolean}
export type OutcomeErrorKind="InvalidThread"|"DifferentThread"|"InvalidTurns"|"InvalidTurn"|"MissingThreadId"|"MissingTurnId"|"MissingStatus"|"UnknownStatus"|"InProgressCompletion"|"InvalidError"|"MissingErrorMessage"|"TurnNotFound"|"InvalidItems";
const messages:Record<OutcomeErrorKind,string>={InvalidThread:"thread/read returned an invalid thread payload",DifferentThread:"thread/read returned a different thread",InvalidTurns:"thread/read returned invalid turns",InvalidTurn:"thread/read returned an invalid turn payload",MissingThreadId:"turn payload had no thread id",MissingTurnId:"turn payload had no turn id",MissingStatus:"turn payload had no status",UnknownStatus:"turn payload had an unknown status",InProgressCompletion:"turn/completed carried an inProgress turn",InvalidError:"turn payload had an invalid error",MissingErrorMessage:"turn payload error had no message",TurnNotFound:"thread/read did not contain the requested turn",InvalidItems:"thread/read returned invalid turn items"};
export class TurnOutcomeError extends Error{readonly kind:OutcomeErrorKind;constructor(kind:OutcomeErrorKind,detail?:string){super(kind==="UnknownStatus"?`${messages[kind]}: ${detail}`:messages[kind]);this.name="TurnOutcomeError";this.kind=kind;}}
function object(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!types.isProxy(value)&&!Array.isArray(value);}
function get(value:unknown,key:string):unknown{if(!object(value))return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,"value")?d.value:undefined;}
const trim=(value:string)=>value.replace(/^\p{White_Space}+/u,"").replace(/\p{White_Space}+$/u,"");
const text=(value:unknown)=>typeof value==="string"?trim(value):"";
const token=(value:unknown)=>typeof value==="string"&&["usageLimitExceeded","UsageLimitExceeded","usage_limit_exceeded","usage_limit_reached","usage_limit"].includes(value);
/** Structured metadata only; never a standalone permission to switch models or enter Reserve. */
export function isUsageLimitError(data:unknown):boolean{
  function visit(value:unknown,depth:number):boolean{
    if(depth>4)return false;if(typeof value==="string")return token(value);if(!object(value))return false;
    const info=get(value,"codexErrorInfo");if(info!==undefined&&info!==null)return visit(info,depth+1);
    return ["type","errorType","reason","code"].some(k=>token(get(value,k)))||visit(get(value,"data"),depth+1);
  }return visit(data,0);
}
function parseError(turn:unknown,status:TurnStatus):{message:string;usage:boolean}{
  const error=get(turn,"error");if(error===undefined||error===null)return {message:"",usage:false};
  if(!object(error))throw new TurnOutcomeError("InvalidError");const message=get(error,"message");if(typeof message!=="string")throw new TurnOutcomeError("MissingErrorMessage");
  if(status!=="Failed")return {message:"",usage:false};return {message:Array.from(trim(message)).slice(0,1000).join(""),usage:isUsageLimitError(error)};
}
function parsePayload(threadId:string,turn:unknown,remote:boolean,terminal:boolean):TurnCompletion{
  if(threadId==="")throw new TurnOutcomeError("MissingThreadId");const turnId=text(get(turn,"id"));if(turnId==="")throw new TurnOutcomeError("MissingTurnId");
  const raw=get(turn,"status");if(typeof raw!=="string")throw new TurnOutcomeError("MissingStatus");let status:TurnStatus;
  switch(raw){case "completed":status="Completed";break;case "interrupted":status="Interrupted";break;case "failed":status="Failed";break;case "inProgress":status="InProgress";break;default:throw new TurnOutcomeError("UnknownStatus",raw);}
  if(terminal&&status==="InProgress")throw new TurnOutcomeError("InProgressCompletion");
  const error=parseError(turn,status),duration=get(turn,"durationMs");
  return Object.freeze({threadId,turnId,status,errorMessage:error.message,interruptOrigin:status==="Interrupted"?(remote?"RemoteUserIntent":"ExternalOrUnknown"):null,durationMs:typeof duration==="bigint"&&duration>=I64_MIN&&duration<=I64_MAX?duration:null,usageLimit:error.usage});
}
/** Input is already-decoded Serde Value, preserving bigint integer versus number float. */
export function parseTurnCompletion(params:unknown,remoteUserIntent:boolean):TurnCompletion{
  if(typeof remoteUserIntent!=="boolean")throw new TypeError("Expected interruption intent flag");
  const threadId=text(get(params,"threadId")),turn=get(params,"turn");if(!object(turn))throw new TurnOutcomeError("InvalidTurn");return parsePayload(threadId,turn,remoteUserIntent,true);
}
export function parseThreadTurnStates(result:unknown,expectedThreadId:string):Map<string,TurnCompletion>{
  const thread=get(result,"thread");if(!object(thread))throw new TurnOutcomeError("InvalidThread");const id=text(get(thread,"id"));if(id!==expectedThreadId)throw new TurnOutcomeError("DifferentThread");
  const turns=get(thread,"turns");if(!Array.isArray(turns))throw new TurnOutcomeError("InvalidTurns");const states=new Map<string,TurnCompletion>();
  for(const turn of turns){if(!object(turn))throw new TurnOutcomeError("InvalidTurn");const completion=parsePayload(id,turn,false,false);states.set(completion.turnId,completion);}
  return new Map([...states].sort(([a],[b])=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
}
/** Bounded terminal fields only; no provider additionalDetails enter the journal. */
export function completionJournalPayload(completion:TurnCompletion):unknown{
  let status:string;switch(completion.status){case "Completed":status="completed";break;case "Interrupted":status="interrupted";break;case "Failed":status="failed";break;case "InProgress":status="inProgress";break;default:throw new TypeError("Unknown completion status");}
  return {threadId:completion.threadId,turn:{id:completion.turnId,status,durationMs:completion.durationMs,error:{message:completion.errorMessage,codexErrorInfo:completion.status==="Failed"&&completion.usageLimit?"usageLimitExceeded":null}}};
}

export interface TurnText {readonly text:string;readonly explicitFinal:boolean}
export interface CompletedFinalAnswer {readonly threadId:string;readonly turnId:string;readonly text:string}
/** Classification is independent of whether async choices are valid/renderable. */
export function isAsyncAgentMessage(item:unknown):boolean{return (get(item,"type")==="agentMessage"||get(item,"type")==="agent_message")&&get(item,"delivery")==="async";}
function agentMessageText(item:unknown):string{
  const direct=text(get(item,"text"));if(direct!=="")return direct;const content=get(item,"content");if(!Array.isArray(content))return "";
  const parts:string[]=[];for(const block of content){const type=get(block,"type"),value=get(block,"text");if((type==="output_text"||type==="text")&&typeof value==="string")parts.push(value);}
  return trim(parts.join("\n"));
}
/** History fallback is explicitly weaker than a final_answer; caller preserves that distinction. */
export function extractTurnText(result:unknown,expectedThreadId:string,expectedTurnId:string):TurnText{
  const thread=get(result,"thread");if(!object(thread))throw new TurnOutcomeError("InvalidThread");if(text(get(thread,"id"))!==expectedThreadId)throw new TurnOutcomeError("DifferentThread");
  const turns=get(thread,"turns");if(!Array.isArray(turns))throw new TurnOutcomeError("InvalidTurns");const turn=turns.find(t=>text(get(t,"id"))===expectedTurnId);if(turn===undefined)throw new TurnOutcomeError("TurnNotFound");
  const items=get(turn,"items");if(!Array.isArray(items))throw new TurnOutcomeError("InvalidItems");let fallback="",final="";
  for(const item of items){const type=get(item,"type");if((type!=="agentMessage"&&type!=="agent_message")||isAsyncAgentMessage(item))continue;
    const message=agentMessageText(item);if(message==="")continue;fallback=message;if(get(item,"phase")==="final_answer")final=message;
  }
  return Object.freeze({text:final!==""?final:fallback,explicitFinal:final!==""});
}
export function extractTurnFinalText(result:unknown,thread:string,turn:string):string{return extractTurnText(result,thread,turn).text;}
export function extractCompletedFinalAnswer(params:unknown):CompletedFinalAnswer|null{
  const item=get(params,"item"),type=get(item,"type");if((type!=="agentMessage"&&type!=="agent_message")||isAsyncAgentMessage(item)||get(item,"phase")!=="final_answer")return null;
  const threadId=text(get(params,"threadId")),turnId=text(get(params,"turnId")),message=agentMessageText(item);if(threadId===""||turnId===""||message==="")return null;
  return Object.freeze({threadId,turnId,text:message});
}
