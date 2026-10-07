import {serdeField,trimmedText} from "./value.ts";
/** Pinned state.rs identity extraction; no ownership or routing permission. */
export function extractThreadId(params:unknown):string|null{
  for(const key of ["threadId","conversationId"]){const value=trimmedText(serdeField(params,key));if(value!=="")return value;}
  const nested=trimmedText(serdeField(serdeField(params,"thread"),"id"));if(nested!=="")return nested;
  const turn=serdeField(params,"turn");for(const key of ["threadId","conversationId"]){const value=trimmedText(serdeField(turn,key));if(value!=="")return value;}return null;
}
export function extractTurnId(params:unknown):string|null{
  for(const key of ["turnId","id"]){const value=trimmedText(serdeField(params,key));if(value!=="")return value;}
  return trimmedText(serdeField(serdeField(params,"turn"),"id"))||null;
}
