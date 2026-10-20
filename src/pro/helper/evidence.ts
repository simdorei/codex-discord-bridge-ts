import {createHash,randomUUID} from 'node:crypto';
import {mkdir,open,rename,readFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
type Kind='browser'|'connector';
const browserProtocol='ask-chatgpt-pro-browser-evidence-v2',connectorProtocol='ask-chatgpt-pro-connector-control-v1',connectorName='Simdorei Local Project Oauth',connectorPath='/plugins/plugin_asdk_app_6a6ae90be0a08191b877eddba93b631c';
const hashes={browser:'346dfe09965e91f6b4339e6c1fcfb14a76c204ef3972779780847d2f7b358853',connector:'a9aa97457ff73e93117d18efa3fa48dd924f00f54935af5c78359cbd5779ccf8'};
const script=(kind:Kind)=>'skills/ask-chatgpt-pro/scripts/'+(kind==='browser'?'browser_evidence_probe.mjs':'pro_connector_control.mjs');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function canonicalProbe(root:string,kind:Kind,retry=false,inner=false):string{
 const uri=JSON.stringify(pathToFileURL(join(root,script(kind))).href),code=kind==='browser'?`nodeRepl.write(JSON.stringify(await (await import(${uri})).probeChrome({ agent, chrome })));`:`nodeRepl.write(JSON.stringify(await (await import(${uri})).prepareProConnector({ proConversationTab })));`;
 if(inner)return code;const variable=kind==='browser'?'browserEvidenceResult':retry?'connectorControlRetryResult':'connectorControlResult';
 return `const ${variable} = await tools.mcp__node_repl__js(${JSON.stringify({code,title:kind==='browser'?'Verify Chrome':'Prepare Pro OAuth connector'})});\nfor (const item of ${variable}.content ?? []) {\n  if (item.type === "text") text(item.text);\n}`;
}
async function bounded(path:string,max=8388608):Promise<string>{const file=await open(path,'r');try{if((await file.stat()).size>max)throw Error('Evidence file exceeds budget');const buffer=Buffer.alloc(max+1);let used=0;for(;;){const {bytesRead}=await file.read(buffer,used,buffer.length-used,null);if(!bytesRead)break;used+=bytesRead;if(used>max)throw Error('Evidence file exceeds budget');}return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used));}finally{await file.close();}}
function embedded(raw:unknown):Record<string,unknown>[]{
 const output:Record<string,unknown>[]=[],strings:string[]=[];let nodes=0;
 const visit=(value:unknown,collect=false,depth=0):void=>{if(++nodes>10000||depth>64)throw Error('Evidence structure exceeds budget');if(typeof value==='string'){if(!collect)strings.push(value);}else if(value!==null&&typeof value==='object'){if(!Array.isArray(value)&&collect)output.push(value as Record<string,unknown>);for(const child of Object.values(value))visit(child,collect,depth+1);}};visit(raw);
 for(const text of strings){let begin=-1,depth=0,quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(begin<0){if(c==='{'){begin=i;depth=1;}continue;}if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{visit(JSON.parse(text.slice(begin,i+1)),true);}catch(error){if(error instanceof SyntaxError){begin=-1;continue;}throw error;}begin=-1;}}
 }return output;
}
function validBrowser(v:Record<string,unknown>):boolean{return v.protocol===browserProtocol&&v.browser_type==='chrome'&&(['available','unverified'].includes(v.status as string)?v.can_report_unavailable===false:v.status==='unavailable'&&v.can_report_unavailable===true&&v.failed_stage==='select_chrome_retry'&&typeof v.public_error==='string'&&v.public_error!=='');}
function validConnector(v:Record<string,unknown>):boolean{return v.protocol===connectorProtocol&&v.browser_type==='chrome'&&v.connector_name===connectorName&&v.connector_path===connectorPath&&(v.status==='verified'&&v.chat_mode==='chat'&&v.pro_mode===true&&['attached','already_attached'].includes(v.action as string)&&!Object.hasOwn(v,'failed_stage')||v.status==='failed'&&v.chat_mode==='unverified'&&v.pro_mode===false&&v.action==='none'&&typeof v.failed_stage==='string'&&v.failed_stage!=='');}
export async function handleEvidence(kind:Kind,payload:Record<string,unknown>,root:string,data:string):Promise<unknown|null>{
 const session=payload.session_id,turn=payload.turn_id;
 const receiptPath=()=>join(data,kind==='browser'?'browser-evidence':'pro-connector-evidence',digest(String(session)+'\0'+String(turn))+'.json');
 if(kind==='browser'&&payload.hook_event_name==='Stop'){
  const message=payload.last_assistant_message;if(typeof message!=='string'||message.trim().replace(/\.+$/u,'').toLowerCase()==='chrome bootstrap was not verified'||!/(?:\bgoogle\s+chrome\b|\bchrome\b).{0,24}(?:\bunavailable\b|\bnot\s+available\b|\bcannot\s+be\s+used\b|\bcan['’]?t\s+be\s+used\b)|(?:구글\s*)?크롬.{0,30}(?:사용\s*불가|사용할\s*수\s*없|연결\s*불가|작동하지\s*않|안\s*(?:돼|됨)|불가능)/isu.test(message))return null;
  let authorized=false;try{const v=JSON.parse(await bounded(receiptPath(),65536));authorized=typeof session==='string'&&typeof turn==='string'&&v.protocol===browserProtocol&&v.session_id===session&&v.turn_id===turn&&v.browser_type==='chrome'&&v.status==='unavailable'&&v.can_report_unavailable===true&&v.probe_sha256===hashes.browser;}catch{}
  return authorized?null:{decision:'block',reason:'Unsupported Chrome unavailability claim blocked. Run the trusted same-turn Chrome evidence probe, or say exactly: Chrome bootstrap was not verified.'};
 }
 if(payload.hook_event_name!=='PostToolUse')return null;
 const input=payload.tool_input as any,code=typeof input==='string'?input:input?.code??input?.input,name=payload.tool_name;
 const expected=['exec','functions.exec'].includes(name as string)?[canonicalProbe(root,kind),...(kind==='connector'?[canonicalProbe(root,kind,true)]:[])]:['js','mcp__node_repl__js','node_repl.js'].includes(name as string)?[canonicalProbe(root,kind,false,true)]:[];
 if(typeof code!=='string'||!expected.some(value=>code===value||code===value+'\n'||code===value+'\r\n'))return null;
 if(digest((await bounded(join(root,script(kind)))).replace(/\r\n?/gu,'\n'))!==hashes[kind])throw Error('evidence_hook_failed stage=probe_integrity_failed');
 if(typeof session!=='string'||!session||typeof turn!=='string'||!turn)throw Error('evidence_hook_failed stage=identity_missing');
 const candidates=embedded(payload.tool_response),receipt:Record<string,unknown>={};
 if(kind==='browser'){const candidate=candidates.find(validBrowser);if(!candidate)return null;for(const key of ['protocol','browser_type','status','can_report_unavailable'])receipt[key]=candidate[key];receipt.tool_use_id=typeof payload.tool_use_id==='string'?payload.tool_use_id:'';}
 else{const valid=candidates.filter(validConnector);if(valid.length===1){for(const key of ['protocol','browser_type','status','connector_name','connector_path','chat_mode','pro_mode','action','failed_stage'])if(Object.hasOwn(valid[0]!,key))receipt[key]=valid[0]![key];}else Object.assign(receipt,{protocol:connectorProtocol,browser_type:'chrome',status:'failed',connector_name:connectorName,connector_path:connectorPath,chat_mode:'unverified',pro_mode:false,action:'none',failed_stage:'evidence_invalid'});}
 Object.assign(receipt,{session_id:session,turn_id:turn,probe_sha256:hashes[kind]});
 const directory=join(data,kind==='browser'?'browser-evidence':'pro-connector-evidence');await mkdir(directory,{recursive:true});const temporary=join(directory,'.'+randomUUID()+'.tmp');
 try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(receipt));await file.sync();}finally{await file.close();}await rename(temporary,receiptPath());}finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
 return null;
}
