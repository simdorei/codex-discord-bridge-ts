import {clonePendingServerRequest,type PendingServerRequest} from '../app-server/server-request-state.ts';
type RecordValue=Record<string,unknown>;
const object=(v:unknown):v is RecordValue=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const field=(v:unknown,k:string):unknown=>object(v)&&Object.hasOwn(v,k)?v[k]:undefined;
function emptySchema(v:unknown):boolean{
 if(!object(v)||field(v,'type')!=='object')return false;
 const properties=field(v,'properties'),required=field(v,'required'),additional=field(v,'additionalProperties');
 return object(properties)&&Object.keys(properties).length===0
  &&(!Object.hasOwn(v,'required')||(Array.isArray(required)&&required.length===0))
  &&(!Object.hasOwn(v,'additionalProperties')||typeof additional==='boolean')
  &&Object.keys(v).every(k=>['type','properties','required','additionalProperties'].includes(k));
}
export interface LocalToolFormResponse{
 readonly response:Readonly<{action:'accept'|'cancel';content:Readonly<Record<string,never>>|null;_meta:null}>;
 readonly disposition:'local-tool-access-auto-accepted'|'unsupported-form-cancelled';
}
/** Pure parity decision for decoded requests. This does not send a response or
 * establish authority. Caller must first verify original owner/turn/generation
 * and send through the exact occurrence-bound response path. */
export function localToolFormResponse(input:PendingServerRequest):LocalToolFormResponse|null{
 const request=clonePendingServerRequest(input),p=request.params,mode=field(p,'mode');
 if(request.method!=='mcpServer/elicitation/request'||(mode!=='form'&&mode!=='openai/form'))return null;
 const meta=field(p,'_meta'),connector=field(meta,'connector_id');
 const accepted=field(p,'serverName')==='node_repl'&&field(meta,'codex_approval_kind')==='mcp_tool_call'
  &&(connector==='computer-use'||connector==='browser')&&field(meta,'riskLevel')==='low'&&emptySchema(field(p,'requestedSchema'));
 return Object.freeze({response:Object.freeze({action:accepted?'accept':'cancel',content:accepted?Object.freeze({}):null,_meta:null}),disposition:accepted?'local-tool-access-auto-accepted':'unsupported-form-cancelled'});
}
