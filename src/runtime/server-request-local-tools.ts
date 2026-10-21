import {clonePendingServerRequest,type PendingServerRequest} from '../app-server/server-request-state.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {requireLocalToolApprovalPolicy,type LocalToolApprovalPolicy} from '../config/runtime.ts';
import {emptyApprovalSchema as emptySchema,isMcpFormRequest as isForm} from '../app-server/mcp-form.ts';
export {emptyApprovalSchema as emptySchema} from '../app-server/mcp-form.ts';
type RecordValue=Record<string,unknown>;
const object=(v:unknown):v is RecordValue=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const field=(v:unknown,k:string):unknown=>object(v)&&Object.hasOwn(v,k)?v[k]:undefined;
export interface LocalToolFormResponse{
 readonly response:Readonly<{action:'accept';content:Readonly<Record<string,never>>;_meta:Readonly<{persist:'always'}>|null}>;
 readonly disposition:'local-tool-access-auto-accepted'|'saved-app-access-auto-accepted'|'local-tool-policy-auto-accepted';
}
export function localToolPolicyResponse(input:PendingServerRequest,policy:LocalToolApprovalPolicy):LocalToolFormResponse|null{
 requireLocalToolApprovalPolicy(policy);
 if(policy!=='allow')return null;
 const request=clonePendingServerRequest(input),p=request.params;
 if(!isLocalForm(request.method,p)||!['low','high'].includes(field(field(p,'_meta'),'riskLevel') as string))return null;
 // Explicit operator policy answers this request only. Native restrictions and
 // persistent-grant metadata are unchanged.
 return Object.freeze({response:Object.freeze({action:'accept',content:Object.freeze({}),_meta:null}),disposition:'local-tool-policy-auto-accepted'});
}
function isLocalForm(method:string,p:unknown):boolean{
 const meta=field(p,'_meta');
 return isForm(method,p)&&field(p,'serverName')==='node_repl'&&field(meta,'codex_approval_kind')==='mcp_tool_call'
  &&['computer-use','browser'].includes(field(meta,'connector_id') as string)&&emptySchema(field(p,'requestedSchema'));
}
export function requiresUserApproval(method:string,params:unknown):boolean{
 // Connector/risk restrictions govern automatic local access, not the owner's
 // ability to answer a valid approval. Unknown tools must reach the prompt.
 return isForm(method,params)&&emptySchema(field(params,'requestedSchema'))
  &&!(isLocalForm(method,params)&&field(field(params,'_meta'),'riskLevel')==='low');
}
function candidate(request:PendingServerRequest):string|null{
 const p=request.params,meta=field(p,'_meta'),persist=field(meta,'persist'),tool=field(meta,'tool_params'),app=field(tool,'app');
 return isLocalForm(request.method,p)&&field(meta,'connector_id')==='computer-use'
  &&['low','high'].includes(field(meta,'riskLevel') as string)&&Array.isArray(persist)&&persist.includes('always')
  &&field(meta,'codex_request_type')===undefined&&field(meta,'tool_name')===undefined
  &&object(tool)&&Object.keys(tool).length===1&&typeof app==='string'&&app!==''&&app.trim()===app&&app!=='computer-audio'?app:null;
}
export function savedAppCandidate(input:PendingServerRequest):string|null{return candidate(clonePendingServerRequest(input));}
function hasSavedGrant(app:string,configRead:unknown):boolean{
 const layers=field(cloneOwnedSerdeValue(configRead),'layers');if(!Array.isArray(layers))return false;
 if(layers.some(layer=>field(field(field(layer,'config'),'computer_use'),'allow_persistent_approval')===false))return false;
 const users=layers.filter(layer=>field(field(layer,'name'),'type')==='user');
 if(users.length!==1)return false;
 const user=users[0],disabled=field(user,'disabledReason');if(disabled!==undefined&&disabled!==null)return false;
 const allowed=field(field(field(field(user,'config'),'computer_use'),'windows'),'always_allowed_app_ids');
 return Array.isArray(allowed)&&allowed.every(id=>typeof id==='string'&&id!==''&&id.trim()===id)&&allowed.includes(app);
}
/** Pure parity decision for decoded requests. This does not send a response or
 * establish authority. Caller must first verify original owner/turn/generation
 * and send through the exact occurrence-bound response path. */
export function localToolFormResponse(input:PendingServerRequest,configRead?:unknown):LocalToolFormResponse|null{
 const request=clonePendingServerRequest(input),p=request.params;
 if(!isForm(request.method,p))return null;
 const app=candidate(request);
 if(app!==null&&configRead!==undefined&&hasSavedGrant(app,configRead))return Object.freeze({response:Object.freeze({action:'accept',content:Object.freeze({}),_meta:Object.freeze({persist:'always'})}),disposition:'saved-app-access-auto-accepted'});
 if(requiresUserApproval(request.method,p))return null;
 const accepted=isLocalForm(request.method,p)&&field(field(p,'_meta'),'riskLevel')==='low';
 // Value-bearing and invalid forms stay pending for a user response or repair.
 return accepted?Object.freeze({response:Object.freeze({action:'accept',content:Object.freeze({}),_meta:null}),disposition:'local-tool-access-auto-accepted'}):null;
}
