import type {ThreadGoalStatus} from "../../app-server/goal.ts";
import type {TurnStatus} from "../../app-server/outcomes.ts";
import {parseSerdeValue} from "../../core/serde-json-parse.ts";
import {requireDiscordText} from "../../discord/text.ts";
export type CompletionStatus=TurnStatus;
export type CompletionGoalStatus=ThreadGoalStatus;
const trim=(text:string)=>text.replace(/^\p{White_Space}+/u,"").replace(/\p{White_Space}+$/u,"");
function field(value:unknown,key:string):unknown{
  if(value===null||typeof value!=="object"||Array.isArray(value))return undefined;
  const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,"value")?d.value:undefined;
}
/** At most four known Serde Value envelopes. A present nonstring nested message blocks fallback. */
export function readableCompletionError(raw:string):string{
  requireDiscordText(raw);let text=trim(raw);
  for(let i=0;i<4;i++){
    let value:unknown;try{value=parseSerdeValue(text);}catch{break;}
    const nested=field(field(value,"error"),"message"),top=field(value,"message");
    const message=nested!==undefined?nested:top!==undefined?top:typeof value==="string"?value:undefined;
    if(typeof message!=="string"||trim(message)===""||message===text)break;
    text=message;
  }
  return text;
}
export function commentaryMessage(text:string):string{requireDiscordText(text);return `In progress\n${text}`;}
/** Pure formatting only: status comes from the separately validated outcome boundary. */
export function completionMessage(status:CompletionStatus,errorMessage:string,exact:string,goal:CompletionGoalStatus|null=null):string{
  requireDiscordText(errorMessage);requireDiscordText(exact);let base:string;
  switch(status){
    case "Completed":base=`Final\n${exact===""?"Completed (no visible reply)":exact}`;break;
    case "Interrupted":base="Interrupted\nCodex turn was interrupted.";break;
    case "Failed":base=`Failed\n${errorMessage===""?"Codex turn failed without an error message.":readableCompletionError(errorMessage)}`;break;
    case "InProgress":base="In progress\nmessage: Codex turn is still running.";break;
    default:throw new TypeError("Unknown completion status");
  }
  if(goal===null||goal==="Complete")return base;
  let name:string;
  switch(goal){case "Active":name="active";break;case "Paused":name="paused";break;case "Blocked":name="blocked";break;case "UsageLimited":name="usage-limited";break;case "BudgetLimited":name="budget-limited";break;default:throw new TypeError("Unknown goal status");}
  return `[Goal status: ${name}]\n${base}`;
}
