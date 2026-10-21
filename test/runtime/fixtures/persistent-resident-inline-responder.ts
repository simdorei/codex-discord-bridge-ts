import {StringDecoder} from 'node:string_decoder';
import {parseLosslessJson,validateRequestId,type RequestId} from '../../../src/protocol/ids.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {measurePassiveValue} from '../../../src/runtime/persistent-resident-services-protocol.ts';

/** Compiled disposable fixture only. The launcher pins process.execPath and this
 * emitted file; no script, command, environment, URL, or scenario is accepted.
 * This responder never executes the approval's illustrative command. */
const TARGET='fixture-target',TURN='fixture-turn',REQUEST='fixture-response-1';
const RECEIVER_REQUEST='fixture-receiver-request';
const RECEIVER_SCENARIOS=Object.freeze(['receiver-computer-form-recovery','receiver-browser-form-event','receiver-unsupported-form-event','receiver-approval-prompt','receiver-input-prompt','receiver-late-accept','receiver-read-json','receiver-native-join','receiver-data-loss','receiver-ack-loss'] as const);
type ReceiverScenario=typeof RECEIVER_SCENARIOS[number];
const MAX_OUTPUT=128*1024,MAX_LINE=8*1024*1024,MAX_FRAMES=128;
const PARAM_BOUNDS=Object.freeze({bytes:16384,units:16384,nodes:1024,edges:1024,depth:16,entries:1024});
let outputBytes=0,notifications=0,requests=0,outstandingRequests=0,inputFrames=0;
let heldMutation:RequestId|null=null,turnStarts=0;
let initialized=false,initializedNotice=false,approvalEmitted=false,approvalAnswered=false,turnActive=false;
let receiverScenario:ReceiverScenario|null=null,receiverAnswered=false;
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
/** Closed original child requests only. Selecting one fixed scenario does not
 * accept a payload, executable, URL, response, or transport implementation. */
async function receiverRequest(scenario:unknown):Promise<void>{
 if(typeof scenario!=='string'||!RECEIVER_SCENARIOS.includes(scenario as ReceiverScenario)||receiverScenario!==null||approvalEmitted||!turnActive||turnStarts!==1||requests!==0||outstandingRequests!==0)refuse();
 receiverScenario=scenario as ReceiverScenario;let method:string,params:Record<string,unknown>;
 if(scenario==='receiver-computer-form-recovery'||scenario==='receiver-browser-form-event'||scenario==='receiver-unsupported-form-event'){
  method='mcpServer/elicitation/request';params={threadId:TARGET,turnId:TURN,serverName:'node_repl',mode:scenario==='receiver-browser-form-event'?'openai/form':'form',message:'Fixed local tool fixture',requestedSchema:{type:'object',properties:{},required:[],additionalProperties:false},_meta:{connector_id:scenario==='receiver-computer-form-recovery'?'computer-use':scenario==='receiver-browser-form-event'?'browser':'unsupported',codex_approval_kind:'mcp_tool_call',riskLevel:'low'}};
  // Unknown connectors now receive an approval prompt. Unsupported-input coverage
  // must require a real value that the bridge cannot synthesize from Allow.
  if(scenario==='receiver-unsupported-form-event')params.requestedSchema={type:'object',properties:{answer:{type:'string'}},required:['answer'],additionalProperties:false};
 }else if(scenario==='receiver-input-prompt'){
  method='item/tool/requestUserInput';params={threadId:TARGET,turnId:TURN,questions:[{id:'fixture-question',question:'Choose one fixed option',isSecret:false,options:[{label:'a'.repeat(79)+' b',description:'detail '.repeat(400)},{label:'Duplicate',description:'First duplicate label'},{label:'Duplicate',description:'Second duplicate label'}]}]};
 }else if(scenario==='receiver-approval-prompt'){
  // Non-form elicitation must remain a human approval prompt, never auto-accept.
  method='mcpServer/elicitation/request';params={threadId:TARGET,turnId:TURN,serverName:'node_repl',mode:'url',message:'Fixed non-form approval fixture'};
 }else{
  method='item/commandExecution/requestApproval';params={threadId:TARGET,turnId:TURN,itemId:'fixture-receiver-item',command:'true',cwd:'/tmp',reason:'Fixed receiver approval fixture'};
 }
 measurePassiveValue(params,PARAM_BOUNDS);requests++;outstandingRequests++;
 await emit({jsonrpc:'2.0',id:RECEIVER_REQUEST,method,params});
 await notify('fixture/receiver-request-emitted',{threadId:TARGET,turnId:TURN,requestId:RECEIVER_REQUEST,requests});
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
    if(Object.hasOwn(params,'receiverScenario')){await receiverRequest(params.receiverScenario);return;}
    if(params.includeTurns===true&&heldMutation!==null){if(!approvalAnswered)refuse();const held=heldMutation;heldMutation=null;await reply(held,{});}
    if(params.includeTurns!==true&&!approvalEmitted)await approval();return;
   default:refuse();
  }
 }
 if(message.id===RECEIVER_REQUEST){
  if(!initialized||receiverScenario===null||receiverAnswered||outstandingRequests!==1||!Object.hasOwn(message,'result')||Object.hasOwn(message,'error'))refuse();
  if(!['receiver-computer-form-recovery','receiver-browser-form-event','receiver-unsupported-form-event'].includes(receiverScenario))refuse();
  const result=record(message.result),action=receiverScenario==='receiver-unsupported-form-event'?'cancel':'accept';
  if(Object.keys(result).length!==3||result.action!==action||result._meta!==null)refuse();
  if(action==='accept'){if(Object.keys(record(result.content)).length!==0)refuse();}else if(result.content!==null)refuse();
  receiverAnswered=true;outstandingRequests--;
  await notify('fixture/receiver-response-received',{threadId:TARGET,requestId:RECEIVER_REQUEST,action,remaining:outstandingRequests});return;
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
