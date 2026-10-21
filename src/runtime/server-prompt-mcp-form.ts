import {compileMcpFormSchema} from '../app-server/mcp-form-schema.ts';
import {AppServerInvalidReplyError} from '../app-server/client-errors.ts';
import {serdeField,serdeObject} from '../app-server/value.ts';
import type {PendingServerRequest} from '../app-server/server-request-state.ts';
import {promptTextFingerprint} from './server-prompt-text-binding.ts';
import type {ServerPrompt} from './server-prompt.ts';

const text=(value:unknown,fallback:string)=>typeof value==='string'&&value.trim()!==''?Array.from(value).slice(0,1000).join(''):fallback;
export function mcpFormPrompt(request:PendingServerRequest,threadId:string,generation:bigint):ServerPrompt{
 const server=text(serdeField(request.params,'serverName'),'MCP server'),message=text(serdeField(request.params,'message'),'Please provide the requested information.');
 const lines=[`MCP input required\nserver: ${server}\n${message}`];
 try{
  const {schema}=compileMcpFormSchema(request.params),properties=schema.properties,required=Array.isArray(schema.required)?schema.required:[];
  if(serdeObject(properties))for(const key of Object.keys(properties).sort())lines.push(`- ${key} (${required.includes(key)?'required':'optional'}): ${JSON.stringify(serdeField(properties,key))}`);
  if(!serdeObject(properties)||Object.keys(properties).length===0)lines.push(`Requested fields: ${JSON.stringify(schema)}`);
  lines.push(serdeObject(properties)&&Object.keys(properties).length===1?'Reply with the value for this field, or a JSON object.':'Reply with one JSON object using the field names above.');
  lines.push('Example format: {"field_name":"value"}. Enter numbers and true/false without quotes. Omit optional fields you do not want to send.');
 }catch(error){
  if(!(error instanceof AppServerInvalidReplyError))throw error;
  lines.push('This input form cannot be validated. The request remains pending. Complete it in the Codex app or ask the plugin to correct its schema.');
 }
 lines.push('Use /decline to refuse or /cancel to cancel this request.','For this exact request, copy the prefix and replace <answer>:',`[codex-reply:${promptTextFingerprint(request,generation)}] <answer>`);
 return Object.freeze({threadId,text:lines.join('\n'),components:Object.freeze([])});
}
