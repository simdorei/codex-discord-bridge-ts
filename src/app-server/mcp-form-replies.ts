import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeField,serdeObject,rustTrim} from './value.ts';
import {compileMcpFormSchema,mcpInvalid,validationJson} from './mcp-form-schema.ts';

function unfence(input:string):string{
 const text=rustTrim(input);
 if(!text.startsWith('```'))return text;
 const match=/^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/u.exec(text);
 if(!match)throw mcpInvalid('Use a complete JSON code block or a JSON object. The request remains pending.');
 return rustTrim(match[1]!);
}
function contentFor(schema:Record<string,unknown>,answer:string):unknown{
 let parsed:unknown;
 try{parsed=parseSerdeValue(answer);}catch{if(answer.startsWith('{')||answer.startsWith('[')||answer.startsWith('"'))throw mcpInvalid('Invalid JSON input. Correct it and reply again; the request remains pending.');}
 if(serdeObject(parsed))return parsed;
 const properties=serdeField(schema,'properties');
 if(!serdeObject(properties)||Object.keys(properties).length!==1)throw mcpInvalid('Reply with a JSON object containing the requested field names; the request remains pending.');
 const key=Object.keys(properties)[0]!,field=serdeField(properties,key);
 const value=serdeField(field,'type')==='string'?(typeof parsed==='string'?parsed:answer):parsed;
 if(value===undefined)throw mcpInvalid('Enter a valid JSON number, true/false, or array for this field; the request remains pending.');
 return {[key]:value};
}
export function buildMcpFormResponse(params:unknown,input:string):Readonly<{payload:unknown;action:string}>{
 if(Buffer.byteLength(input)>65536)throw mcpInvalid('MCP input exceeds the 64 KiB input limit; the request remains pending.');
 const answer=unfence(input);
 if(answer==='/cancel'||answer==='/decline'){
  const action=answer.slice(1);return {action,payload:{action,content:null,_meta:null}};
 }
 const {schema,validate}=compileMcpFormSchema(params),content=contentFor(schema,answer);
 if(validate(validationJson(content))!==true){
  const error=validate.errors?.[0],path=error?.instancePath||'/',keyword=error?.keyword??'schema';
  throw mcpInvalid(`MCP input does not satisfy ${keyword} at ${path}: ${error?.message??'invalid field'}. Correct the field and reply again; the request remains pending.`);
 }
 return {action:'accept',payload:cloneOwnedSerdeValue({action:'accept',content,_meta:null})};
}
