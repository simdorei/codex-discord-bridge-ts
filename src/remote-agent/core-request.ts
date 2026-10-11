import {requestObject,object,text,boolean,integer,enumeration,nullable,strings,required,defaulted,fields,length,count,validationError,jsonError} from './request-input.ts';
export interface FileChange {
 readonly action:'create'|'update'|'delete'|'move';readonly path:string;readonly content:string|null;readonly destination:string|null;readonly expected_sha256:string|null;
}
export type CoreRequest=
 | Readonly<{kind:'project_rules'|'project_status'|'command_list'|'repo_status'|'repo_diff'|'list_images'|'checkpoint_list'}>
 | Readonly<{kind:'code_search';query:string;max_results:bigint}>
 | Readonly<{kind:'file_apply_patch';changes:readonly FileChange[]}>
 | Readonly<{kind:'file_create';path:string;content:string;overwrite:boolean}>
 | Readonly<{kind:'command_run';command_id:string;timeout_seconds:bigint}>
 | Readonly<{kind:'git_commit';message:string;paths:readonly string[]}>
 | Readonly<{kind:'git_push';remote:string;branch:string|null}>
 | Readonly<{kind:'save_image';path:string;data_base64:string;overwrite:boolean}>
 | Readonly<{kind:'save_image_from_url';path:string;url:string;overwrite:boolean}>
 | Readonly<{kind:'retrieve_image';path:string}>
 | Readonly<{kind:'checkpoint_show'|'checkpoint_restore';checkpoint_id:string}>;
const optionalText=nullable(text),u16=integer(0n,65535n),action=enumeration(['create','update','delete','move'] as const);
function decodeChange(value:unknown):FileChange {
 const v=object(value),allowed=['action','path','content','destination','expected_sha256'];
 if(Object.keys(v).some(key=>!allowed.includes(key)))jsonError('unknown file change field');
 return Object.freeze({action:required(v,'action',action),path:required(v,'path',text),content:defaulted(v,'content',optionalText,null),destination:defaulted(v,'destination',optionalText,null),expected_sha256:defaulted(v,'expected_sha256',optionalText,null)});
}
function changes(value:unknown):readonly FileChange[]{if(!Array.isArray(value))return jsonError('expected file change array');return Object.freeze(value.map(decodeChange));}
function decode(raw:string,maxBytes:number):CoreRequest {
 const v=requestObject(raw,maxBytes),kind=required(v,'kind',text);
 switch(kind){
  case 'project_rules':case 'project_status':case 'command_list':case 'repo_status':case 'repo_diff':case 'list_images':case 'checkpoint_list':fields(v,[]);return Object.freeze({kind});
  case 'code_search':fields(v,['query','max_results']);return Object.freeze({kind,query:required(v,'query',text),max_results:defaulted(v,'max_results',u16,100n)});
  case 'file_apply_patch':fields(v,['changes']);return Object.freeze({kind,changes:required(v,'changes',changes)});
  case 'file_create':fields(v,['path','content','overwrite']);return Object.freeze({kind,path:required(v,'path',text),content:required(v,'content',text),overwrite:defaulted(v,'overwrite',boolean,false)});
  case 'command_run':fields(v,['command_id','timeout_seconds']);return Object.freeze({kind,command_id:required(v,'command_id',text),timeout_seconds:defaulted(v,'timeout_seconds',u16,60n)});
  case 'git_commit':fields(v,['message','paths']);return Object.freeze({kind,message:required(v,'message',text),paths:required(v,'paths',strings)});
  case 'git_push':fields(v,['remote','branch']);return Object.freeze({kind,remote:defaulted(v,'remote',text,'origin'),branch:defaulted(v,'branch',optionalText,null)});
  case 'save_image':fields(v,['path','data_base64','overwrite']);return Object.freeze({kind,path:required(v,'path',text),data_base64:required(v,'data_base64',text),overwrite:defaulted(v,'overwrite',boolean,false)});
  case 'save_image_from_url':fields(v,['path','url','overwrite']);return Object.freeze({kind,path:required(v,'path',text),url:required(v,'url',text),overwrite:defaulted(v,'overwrite',boolean,false)});
  case 'retrieve_image':fields(v,['path']);return Object.freeze({kind,path:required(v,'path',text)});
  case 'checkpoint_show':case 'checkpoint_restore':fields(v,['checkpoint_id']);return Object.freeze({kind,checkpoint_id:required(v,'checkpoint_id',text)});
  default:return jsonError('unknown core request kind');
 }
}
function match(field:string,value:string,pattern:RegExp):void{if(pattern.exec(value)?.[0]!==value)validationError(field,'invalid value');}
function range(field:string,value:bigint,min:bigint,max:bigint):void{if(value<min||value>max)validationError(field,`must be between ${min} and ${max}`);}
function validateChange(v:FileChange):void {
 length('path',v.path,1,1000);if(v.content!==null)length('content',v.content,0,1048576);if(v.destination!==null)length('destination',v.destination,1,1000);
 if(v.expected_sha256!==null&&(v.expected_sha256.length!==64||!/^[a-f0-9]{64}$/u.test(v.expected_sha256)))validationError('expected_sha256','must be 64 lowercase hexadecimal characters');
 if((v.action==='create'||v.action==='update')&&v.content===null)validationError('content',`${v.action} requires content`);
 if(v.action!=='create'&&v.expected_sha256===null)validationError('expected_sha256','operation requires expected_sha256');
 if(v.action==='move'&&v.destination===null)validationError('destination','move requires destination');
 if(v.action==='create'&&v.expected_sha256!==null)validationError('expected_sha256','create does not accept expected_sha256');
 if(v.action==='delete'&&v.content!==null)validationError('content','delete does not accept content');
 if(v.action!=='move'&&v.destination!==null)validationError('destination','destination is only valid for move');
}
/** Complete core request shape and source validation. URL parsing uses Node's
 * WHATWG implementation; exhaustive Rust url-crate edge parity is unqualified.
 * No network, file, Git, command, checkpoint or image operation is performed. */
export function parseCoreRequest(raw:string,maxBytes:number):CoreRequest {
 const v=decode(raw,maxBytes);
 switch(v.kind){
  case 'code_search':length('query',v.query,1,500);range('max_results',v.max_results,1n,200n);break;
  case 'file_apply_patch':{
   count('changes',v.changes.length,1,200);let size=0;
   for(const change of v.changes){validateChange(change);size+=change.content===null?0:Buffer.byteLength(change.content);}
   if(size>10485760)validationError('changes','combined file change content exceeds 10 MiB');break;
  }
  case 'file_create':length('path',v.path,1,1000);length('content',v.content,0,1048576);break;
  case 'command_run':length('command_id',v.command_id,1,300);range('timeout_seconds',v.timeout_seconds,1n,300n);break;
  case 'git_commit':length('message',v.message,1,500);count('paths',v.paths.length,1,200);break;
  case 'git_push':match('remote',v.remote,/^[A-Za-z0-9._-]+$/u);if(v.branch!==null){length('branch',v.branch,0,250);match('branch',v.branch,/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u);}break;
  case 'save_image':length('path',v.path,1,1000);length('data_base64',v.data_base64,4,7000000);break;
  case 'save_image_from_url':{
   length('path',v.path,1,1000);let parsed:URL;
   try{parsed=new URL(v.url);}catch{validationError('url','invalid URL');}
   if(!['http:','https:'].includes(parsed!.protocol)||parsed!.hostname==='')validationError('url','must be an HTTP or HTTPS URL');break;
  }
  case 'retrieve_image':length('path',v.path,1,1000);break;
  case 'checkpoint_show':case 'checkpoint_restore':match('checkpoint_id',v.checkpoint_id,/^cp_[a-f0-9]{16}$/u);break;
 }
 return v;
}
