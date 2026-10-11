import {boolean,enumeration,integer,jsonError,nullable,requestObject,strings,text,validationError} from './request-input.ts';
import {outputRecord as record,outputArray as array} from './output-input.ts';

const u64=integer(0n,18446744073709551615n);
const i64=integer(-9223372036854775808n,9223372036854775807n);
const rule=record({path:text,content:text});
const match=record({path:text,line:u64,snippet:text});
const patch=record({path:text,action:enumeration(['add','update','delete','move']),destination:nullable(text),added_lines:u64,removed_lines:u64},['destination']);
const descriptor=record({command_id:text,display:text,source:text,risk_tier:enumeration(['read','verify','network','destructive'])});
const diff=record({path:text,added:u64,removed:u64});
const image=record({path:text,media_type:text,size_bytes:u64});
const checkpoint=record({checkpoint_id:text,created_at:text,reason:text});

const schemas={
 project_rules:record({rules:array(rule)}),
 project_status:record({branch:text,dirty_files:strings,staged_files:strings,rule_files:strings,command_ids:strings}),
 code_search:record({matches:array(match)}),
 file_apply_patch:record({applied:array(patch),checkpoint_id:text}),
 file_create:record({path:text,sha256:text,bytes_written:u64,checkpoint_id:text}),
 command_list:record({commands:array(descriptor)}),
 command_run:record({command_id:text,exit_code:i64,stdout:text,stderr:text,duration_ms:u64,truncated:boolean}),
 repo_status:record({branch:text,dirty_files:strings,staged_files:strings,remotes:strings,upstream:nullable(text),ahead:u64,behind:u64},['upstream']),
 repo_diff:record({files:array(diff),summary:text,patch:text,truncated:boolean}),
 git_commit:record({commit:text,branch:text,staged_files:strings}),
 git_push:record({remote:text,branch:text,output:text}),
 image_save:record({image,sha256:text}),
 image_list:record({images:array(image)}),
 image_retrieve:record({image,data_base64:text}),
 checkpoint_list:record({checkpoints:array(checkpoint)}),
 checkpoint_show:record({checkpoint,patch:text}),
 checkpoint_restore:record({checkpoint_id:text,restored_files:strings}),
} as const;
export type RemoteCoreOutput = {[K in keyof typeof schemas]:Readonly<{kind:K}>&ReturnType<(typeof schemas)[K]>}[keyof typeof schemas];

/** Internal fresh-JSON decoder; validation is separate so enclosing messages
 * can finish complete deserialization before any semantic error is raised. */
export function decodeCoreOutputObject(input:Record<string,unknown>):RemoteCoreOutput{
 if(!Object.hasOwn(input,'kind'))return jsonError('missing kind');
 const kind=text(input.kind);
 if(!Object.hasOwn(schemas,kind))return jsonError('unknown core output kind');
 const payload:Record<string,unknown>=Object.create(null);
 for(const key of Object.keys(input))if(key!=='kind')payload[key]=input[key];
 const decoded=schemas[kind as keyof typeof schemas](payload);
 return Object.freeze({kind,...decoded}) as RemoteCoreOutput;
}
export function validateCoreOutput(value:RemoteCoreOutput):void{
 if(value.kind==='code_search'&&value.matches.some(item=>item.line===0n))validationError('line','must be at least 1');
 // Rust's only other check is image_retrieve base64 length 0..usize::MAX.
 // Bounded input and an already decoded string meet it; no base64 decoding,
 // path, hash, timestamp or command-execution authorization is implied.
}
export function parseCoreOutput(raw:string,maxBytes:number):RemoteCoreOutput{
 const result=decodeCoreOutputObject(requestObject(raw,maxBytes));validateCoreOutput(result);return result;
}
