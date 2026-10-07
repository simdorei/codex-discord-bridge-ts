import {serializeSerdeValue} from "./serde-json.ts";
/** Format the existing lossless serializer's tokens without reparsing numbers. */
export function serializePrettySerdeValue(value:unknown):string{
  const compact=serializeSerdeValue(value);let out="",depth=0,quoted=false,escaped=false;
  const indent=()=>"  ".repeat(depth);
  for(let i=0;i<compact.length;i++){
    const c=compact[i]!;
    if(quoted){out+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;out+=c;}
    else if(c==='{'||c==='['){out+=c;const end=c==='{'?'}':']';if(compact[i+1]===end){out+=end;i++;}else{depth++;out+='\n'+indent();}}
    else if(c==='}'||c===']'){depth--;out+='\n'+indent()+c;}
    else if(c===',')out+=',\n'+indent();
    else if(c===':')out+=': ';
    else out+=c;
  }
  return out;
}
