import {StringDecoder} from 'node:string_decoder';
import {parseLosslessJson,validateRequestId,type RequestId} from '../../../src/protocol/ids.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {measurePassiveValue} from '../../../src/runtime/persistent-resident-services-protocol.ts';

/** Compiled disposable fixture only. The launcher pins process.execPath and this
 * emitted file; no script, command, environment, URL, or scenario is accepted.
 * This responder never executes the approval's illustrative command. */
const TARGET='fixture-target',TURN='fixture-turn',REQUEST='fixture-response-1';
const MAX_OUTPUT=128*1024,MAX_LINE=8*1024*1024,MAX_FRAMES=128;
const PARAM_BOUNDS=Object.freeze({bytes:16384,units:16384,nodes:1024,edges:1024,depth:16,entries:1024});
let outputBytes=0,notifications=0,requests=0,outstandingRequests=0,inputFrames=0;
let heldMutation:RequestId|null=null,turnStarts=0;
let initialized=false,initializedNotice=false,approvalEmitted=false,approvalAnswered=false,turnActive=false;
function refuse():never {throw new Error('Fixed resident fixture protocol refused');}
function record(value:unknown):Record<string,unknown>{if(value===null||typeof value!=='object'||Array.isArray(value))refuse();return value as Record<string,unknown>;}
async function emit(value:unknown):Promise<void>{
 const line=serializeSerdeValue(value)+'\n',bytes=Buffer.byteLength(line,'utf8');if(outputBytes+bytes>MAX_OUTPUT)refuse();outputBytes+=bytes;
 await new Promise<void>((resolve,reject)=>{process.stdout.write(line,error=>error?reject(error):resolve());});
}
async function notify(method:string,params:unknown):Promise<void>{if(notifications>=8)refuse();measurePassiveValue(params,PARAM_BOUNDS);notifications++;await emit({jsonrpc:'2.0',method,params});}
async function reply(id:RequestId,result:unknown):Promise<void>{measurePassiveValue(result,PARAM_BOUNDS);await emit({jsonrpc:'2.0',id,result});}
async function approval():Promise<void>{
 if(approvalEmitted||requests>=2||outstandingRequests>=2)refuse();
 const params=Object.freeze({threadId:TARGET,turnId:TURN,itemId:'fixture-item',command:'true',cwd:'/tmp',reason:null});measurePassiveValue(params,PARAM_BOUNDS);
 approvalEmitted=true;requests++;outstandingRequests++;
 await emit({jsonrpc:'2.0',id:REQUEST,method:'item/commandExecution/requestApproval',params});
}
async function consume(line:string):Promise<void>{
 if(++inputFrames>MAX_FRAMES)refuse();const message=record(parseLosslessJson(line));
 if(Object.hasOwn(message,'method')){
  if(typeof message.method!=='string')refuse();
  if(!Object.hasOwn(message,'id')){if(message.method!=='initialized'||!initialized||initializedNotice)refuse();initializedNotice=true;return;}
  const id=validateRequestId(message.id),method=message.method;
  if(method==='initialize'){if(initialized)refuse();initialized=true;await reply(id,{});return;}
  if(!initialized||!initializedNotice)refuse();
  const params=record(message.params);
  if(method==='thread/settings/update'&&params.threadId==='fixture-independent'){
   if(heldMutation!==null)refuse();heldMutation=id;await notify('fixture/mutation-held',{threadId:'fixture-independent'});return;
  }
  if(params.threadId!==TARGET)refuse();
  switch(method){
   case 'thread/settings/update':await reply(id,{});return;
   case 'thread/resume':await reply(id,{thread:{id:TARGET}});return;
   case 'turn/start':
    if(turnActive||turnStarts!==0)refuse();turnActive=true;turnStarts++;await reply(id,{turn:{id:TURN}});await notify('turn/started',{threadId:TARGET,turn:{id:TURN}});return;
   case 'turn/interrupt':
    await reply(id,{});if(turnActive){turnActive=false;await notify('turn/completed',{threadId:TARGET,turn:{id:TURN,status:'interrupted'}});}return;
   case 'thread/read':
    await reply(id,{thread:{id:TARGET,turns:[]},fixture:{responses:approvalAnswered?1:0,turnStarts}});
    if(params.includeTurns===true&&heldMutation!==null){if(!approvalAnswered)refuse();const held=heldMutation;heldMutation=null;await reply(held,{});}
    if(params.includeTurns!==true&&!approvalEmitted)await approval();return;
   default:refuse();
  }
 }
 if(!initialized||message.id!==REQUEST||!approvalEmitted||approvalAnswered||outstandingRequests!==1||Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))refuse();
 // The possibly multi-megabyte response is consumed once and never echoed,
 // retained in a history, copied into output, or interpreted as instructions.
 approvalAnswered=true;outstandingRequests--;
 await notify('fixture/response-received',{threadId:TARGET,requestId:REQUEST,requests,remaining:outstandingRequests,emittedBytesBeforeAck:outputBytes});
}
async function main():Promise<void>{
 if(process.argv.length!==2)refuse();const decoder=new StringDecoder('utf8');let pending='';
 for await(const chunk of process.stdin){
  const text=decoder.write(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk));let offset=0;
  while(offset<text.length){const newline=text.indexOf('\n',offset),end=newline<0?text.length:newline,part=text.slice(offset,end);
   if(Buffer.byteLength(pending,'utf8')+Buffer.byteLength(part,'utf8')>MAX_LINE)refuse();pending+=part;
   if(newline<0)break;const line=pending;pending='';if(line.length===0)refuse();await consume(line);offset=newline+1;
  }
 }
 const tail=decoder.end();if(tail!==''||pending!=='')refuse();
}
void main().catch(()=>{process.exitCode=1;process.stdin.destroy();});
