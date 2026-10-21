import {clonePendingServerRequest,type PendingServerRequest} from '../app-server/server-request-state.ts';
import {buildApprovalResponse} from '../app-server/approval-replies.ts';
import {requireApprovalPolicy,type ApprovalPolicy} from '../config/runtime.ts';
import {emptySchema} from './server-request-local-tools.ts';
import {isMcpFormRequest} from '../app-server/mcp-form.ts';

/** Explicit operator approval policy. The caller must still verify original
 * owner, turn, generation and occurrence before submitting this response. */
export function approvalPolicyResponse(input:PendingServerRequest,policy:ApprovalPolicy):Readonly<{response:unknown;disposition:'approval-policy-auto-accepted'}>|null {
 requireApprovalPolicy(policy);
 if(policy!=='allow')return null;
 const request=clonePendingServerRequest(input);
 const p=request.params!==null&&typeof request.params==='object'&&!Array.isArray(request.params)?request.params as Record<string,unknown>:undefined;
 const approval=['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval','execCommandApproval','applyPatchApproval'].includes(request.method)
  ||(request.method==='mcpServer/elicitation/request'&&(p?.mode==='url'||(isMcpFormRequest(request.method,p)&&emptySchema(p?.requestedSchema))));
 if(!approval)return null;
 // Exactly the owner's Allow payload; no permanent native grant or input data.
 return Object.freeze({response:buildApprovalResponse(request.method,request.params,'1').payload,disposition:'approval-policy-auto-accepted'});
}
