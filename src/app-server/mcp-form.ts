import {serdeField,serdeObject} from './value.ts';

export function isMcpFormRequest(method:string,params:unknown):boolean{
 if(method!=='mcpServer/elicitation/request')return false;
 const mode=serdeField(params,'mode');
 return mode==='form'||mode==='openai/form'||(mode===undefined&&serdeField(params,'requestedSchema')!==undefined);
}
export function emptyApprovalSchema(value:unknown):boolean{
 if(!serdeObject(value)||serdeField(value,'type')!=='object')return false;
 const properties=serdeField(value,'properties'),required=serdeField(value,'required'),additional=serdeField(value,'additionalProperties');
 return serdeObject(properties)&&Object.keys(properties).length===0
  &&(!Object.hasOwn(value,'required')||(Array.isArray(required)&&required.length===0))
  &&(!Object.hasOwn(value,'additionalProperties')||typeof additional==='boolean')
  &&Object.keys(value).every(key=>['type','properties','required','additionalProperties'].includes(key)
   ||(['title','description','$schema','$id','$comment'].includes(key)&&typeof serdeField(value,key)==='string'));
}
export function mcpFormNeedsInput(method:string,params:unknown):boolean{
 return isMcpFormRequest(method,params)&&!emptyApprovalSchema(serdeField(params,'requestedSchema'));
}
