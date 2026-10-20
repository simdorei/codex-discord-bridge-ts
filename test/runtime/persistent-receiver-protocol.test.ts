import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MessageChannel,MessagePort} from 'node:worker_threads';
import {boundedSerdeByteCount} from '../../src/core/serde-byte-count.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
import {boundApprovalButtonRow,boundInputButtonRow,busyButtonRow,captureServerPromptComponentTransfer,restoreServerPromptComponentTransfer,serializeDiscordComponent,type ActionRowComponent,type DiscordComponent} from '../../src/discord/components.ts';
import {idempotentMessageRequestWithComponents} from '../../src/discord/idempotent-message.ts';
import {receiptHash} from '../../src/store/delivery-receipt-key.ts';
import {CompletionHeldError,CompletionDeliveryError,isCompletionHeld} from '../../src/runtime/completion/receipt-sender.ts';
import {CompletionReceiptUnconfirmedError} from '../../src/runtime/completion/native-receipt-store.ts';
import {NativeStoreReadError,type NativeStoreReadDiagnostic} from '../../src/runtime/native-store-read-diagnostic.ts';
import {NativeControlEvidenceUnavailable} from '../../src/runtime/action-executor/control-evidence-native.ts';
import {NativeQueueReadUnavailableError} from '../../src/runtime/queue-runner/native-read-state.ts';
import {NativePromptIntakeUnavailableError} from '../../src/runtime/prompt-intake/native-state.ts';
import {OwnedWorkerBusyError,OwnedWorkerBudgetError} from '../../src/runtime/owned-worker-slot.ts';
import {captureReceiverOperation,captureReceiverTerminal,captureReceiverCommand,captureReceiverReply,captureReceiverControlCommand,captureReceiverControlReply,captureReceiverDescriptor,receiverFrame,projectReceiverFailure,throwReceiverFailure,PersistentPromptReadUnclassifiedError,PersistentPromptChunkUnclassifiedError,RECEIVER_LIMITS,type ReceiverOperation,type ReceiverFailure,type ReceiverCommand,type ReceiverReply} from '../../src/runtime/persistent-receiver-protocol.ts';
import type {PersistentPromptReadJob} from '../../src/runtime/persistent-prompt-read-values.ts';

const epoch='a'.repeat(32),occurrence=new Uint8Array(16),domain='server-request/prompt/v1';
const observed=captureReceiverOperation({op:'observed-completion',thread:'thread',turn:'turn'});
const jobs=captureReceiverOperation({op:'all-jobs'});
const mapping=captureReceiverOperation({op:'channel-mapping',channel:1n});
test('sealed non-admission proof requires exact next ID, retired prefix and original epoch',()=>{
 const body={kind:'sealed-no-admission' as const,id:1,retiredThrough:0};assert.deepEqual(captureReceiverReply(receiverFrame(epoch,body),epoch),body);
 for(const value of [{...body,id:0},{...body,id:2},{...body,retiredThrough:-1},{...body,retiredThrough:1},{...body,id:1.5},{...body,extra:true}])assert.throws(()=>captureReceiverReply({version:1,epoch,body:value},epoch),TypeError);
 assert.throws(()=>captureReceiverReply({version:1,epoch:'b'.repeat(32),body},epoch),TypeError);
});
const chunk=captureReceiverOperation({op:'server-prompt-chunk',channel:1n,logicalKey:'request\0raw',chunkIndex:0n,content:'prompt',components:'[]'});
function job():PersistentPromptReadJob{return {jobId:'job',targetThreadId:'thread',channelId:-(1n<<63n),ownerUserId:null,discordMessageId:(1n<<63n)-1n,
 appServerGeneration:-1n,executionGeneration:null,turnObservationGeneration:2n,goalWaiting:false,prompt:'🙂\0',queued:false,ackSent:true,state:'Running',attemptCount:-1n,
 turnId:null,baselineTurnIds:['','\0','🙂'],lastError:'',createdAt:-0,updatedAt:1.25};}
function thrown(fn:()=>never):unknown{try{fn();assert.fail('Expected throw');}catch(error){return error;}}
function terminalFailure(operation:ReceiverOperation,failure:ReceiverFailure):unknown{return thrown(()=>throwReceiverFailure(operation,failure));}
function componentBytes(value:readonly DiscordComponent[]):string{return `[${value.map(serializeDiscordComponent).join(',')}]`;}

test('four exact path-free operations preserve types, originals and owned snapshots',()=>{
 const inputs=[{op:'observed-completion',thread:'',turn:'\0'}, {op:'all-jobs'}, {op:'channel-mapping',channel:-(1n<<63n)},
  {...chunk,logicalKey:'arbitrary🙂\0request-id',chunkIndex:(1n<<64n)-1n}];
 for(const input of inputs){const captured=captureReceiverOperation(input);assert.deepEqual(captured,input);assert.ok(Object.isFrozen(captured));assert.equal(captureReceiverOperation(captured),captured);assert.deepEqual(captureReceiverOperation(structuredClone(captured)),captured);}
 const input={...chunk,content:'before'},captured=captureReceiverOperation(input);input.content='after';assert.equal(captured.op==='server-prompt-chunk'&&captured.content,'before');
 for(const value of [null,[],{}, {op:'all-jobs',path:'/forbidden'}, {...chunk,domain}, {...chunk,guard:null}, {...chunk,send:()=>{}}, {...chunk,chunkIndex:0},
  {...chunk,channel:0n},{...chunk,channel:1n<<63n},{...chunk,chunkIndex:-1n},{...chunk,chunkIndex:1n<<64n},{...chunk,logicalKey:'\ud800'}, {...chunk,content:'\udfff'}])assert.throws(()=>captureReceiverOperation(value),TypeError);
});
test('original identity/key limits and separate 2000-scalar representation boundary remain exact',()=>{
 assert.equal(captureReceiverOperation({...observed,thread:'a'.repeat(16384)}).op,'observed-completion');
 assert.throws(()=>captureReceiverOperation({...observed,thread:'a'.repeat(16385)}),TypeError);
 const base=boundedSerdeByteCount([1n,domain,'',0n],RECEIVER_LIMITS.receiptKeyBytes)!;
 const logicalKey='a'.repeat(RECEIVER_LIMITS.receiptKeyBytes-base);
 assert.equal(Buffer.byteLength(serializeSerdeValue([1n,domain,logicalKey,0n])),RECEIVER_LIMITS.receiptKeyBytes);
 assert.equal(captureReceiverOperation({...chunk,logicalKey}).op,'server-prompt-chunk');
 assert.throws(()=>captureReceiverOperation({...chunk,logicalKey:logicalKey+'a'}),TypeError);
 assert.equal(captureReceiverOperation({...chunk,content:'🙂'.repeat(2000)}).op,'server-prompt-chunk');
 assert.throws(()=>captureReceiverOperation({...chunk,content:'🙂'.repeat(2001)}),TypeError);
 // A wider transport representation does not expand the original sender rule.
 assert.throws(()=>idempotentMessageRequestWithComponents(1n,'a'.repeat(1901),[],domain,'key',0n));
});
test('approval and input components reconstruct only exact private helper output',()=>{
 const values=[[],[boundApprovalButtonRow('thread',1n,occurrence,'request')],
  [boundInputButtonRow('thread',1n,occurrence,'request',[['1','same'],['2','same']])]];
 for(const value of values){const wire=captureServerPromptComponentTransfer(value);assert.equal(wire,componentBytes(value));const restored=restoreServerPromptComponentTransfer(wire);assert.equal(componentBytes(restored),wire);assert.equal(captureServerPromptComponentTransfer(restored),wire);assert.ok(Object.isFrozen(restored));}
 const owned=[boundApprovalButtonRow('thread',1n,occurrence,'request')];
 assert.throws(()=>captureServerPromptComponentTransfer(structuredClone(owned)));
 assert.throws(()=>captureServerPromptComponentTransfer([busyButtonRow('a'.repeat(24),false)]));
});
test('trim-before-truncation final whitespace and duplicate labels retain request and receipt hash',()=>{
 const label='a'.repeat(79)+' '+'b',source=[boundInputButtonRow('thread',1n,occurrence,'request',[['1',label],['2',label]])];
 const wire=captureServerPromptComponentTransfer(source),restored=restoreServerPromptComponentTransfer(wire),row=restored[0] as ActionRowComponent;
 assert.equal(row.components[0]!.label,'a'.repeat(79)+' ');assert.equal(row.components[1]!.label,row.components[0]!.label);
 const before=idempotentMessageRequestWithComponents(1n,'content',source,domain,'key',0n),after=idempotentMessageRequestWithComponents(1n,'content',restored,domain,'key',0n);
 assert.deepEqual(after,before);assert.equal(receiptHash(`[${JSON.stringify('content')},${wire}]`),receiptHash(`[${JSON.stringify('content')},${componentBytes(restored)}]`));
 assert.notEqual(receiptHash(`[${JSON.stringify('content')},${wire}]`),receiptHash(`[${JSON.stringify('content')},${wire.replaceAll('a ','a')}]`));
});
test('component reconstruction rejects noncanonical encodings, foreign IDs, positions, fields and malformed labels',()=>{
 const original=JSON.parse(captureServerPromptComponentTransfer([boundInputButtonRow('thread',1n,occurrence,'request',[['1','one'],['2','two']])])) as {type:number;components:{type:number;custom_id:string;label:string;style:number}[]}[];
 const changes:(()=>unknown)[]=[()=>[...original,...original],()=>[{...original[0],extra:0}],()=>[{...original[0],type:2}],
  ()=>[{...original[0],components:[]}],()=>[{...original[0],components:original[0]!.components.map((b,i)=>i?{...b,custom_id:original[0]!.components[0]!.custom_id}:b)}],
  ...['',' one','one ','\ud800','a'.repeat(81)].map(label=>()=>[{...original[0],components:original[0]!.components.map((b,i)=>i?b:{...b,label})}]),
  ()=>[{...original[0],components:original[0]!.components.map((b,i)=>i?b:{...b,style:2})}],
  ()=>[{...original[0],components:original[0]!.components.map((b,i)=>i?b:{...b,custom_id:b.custom_id.replace(':v2:',':v3:')})}],
  ()=>[{...original[0],components:original[0]!.components.map((b,i)=>i?b:{...b,url:'https://invalid.example/'})}]];
 for(const change of changes)assert.throws(()=>restoreServerPromptComponentTransfer(JSON.stringify(change())));
 const wire=JSON.stringify(original);
 for(const altered of [' '+wire,wire+' ',wire.replace('"type":1','"type":1,"type":1'),wire.replace('one','\\u006fne'),wire.replace('"type":1','"type":1.0'),'[ ]','x'.repeat(8193)])assert.throws(()=>restoreServerPromptComponentTransfer(altered));
 const approvals=JSON.parse(captureServerPromptComponentTransfer([boundApprovalButtonRow('thread',1n,occurrence,'request')]));approvals[0].components.reverse();assert.throws(()=>restoreServerPromptComponentTransfer(JSON.stringify(approvals)));
});
test('component capture and all wire boundaries refuse accessors/proxies without invoking them',()=>{
 let calls=0;const accessor=Object.defineProperty({},'op',{enumerable:true,get(){calls++;return 'all-jobs';}});
 assert.throws(()=>captureReceiverOperation(accessor),TypeError);assert.throws(()=>captureReceiverOperation(new Proxy({op:'all-jobs'},{get(){calls++;return 'all-jobs';}})),TypeError);
 const row=boundApprovalButtonRow('thread',1n,occurrence,'request'),bad=Object.defineProperty([],'0',{enumerable:true,get(){calls++;return row;}});
 assert.throws(()=>captureServerPromptComponentTransfer(bad));
 const body=Object.defineProperty({},'kind',{enumerable:true,get(){calls++;return 'ready';}});assert.throws(()=>captureReceiverCommand({version:1,epoch,body},epoch),TypeError);
 const result=Object.defineProperty({kind:'ok'},'value',{enumerable:true,get(){calls++;return [];} });assert.throws(()=>captureReceiverTerminal(jobs,result),TypeError);
 assert.equal(calls,0);
});
test('successful reads preserve complete schema, row order and nullable mapping constraints',()=>{
 const rows=[{...job(),baselineTurnIds:['','\0','🙂']},{...job(),jobId:'next',baselineTurnIds:['second','first']}],result=captureReceiverTerminal(jobs,{kind:'ok',value:rows});
 assert.equal(result.kind,'ok');if(result.kind!=='ok')assert.fail();assert.deepEqual(result.value,rows);assert.notEqual(result.value,rows);assert.ok(Object.isFrozen(result.value));
 const copied=result.value as readonly PersistentPromptReadJob[];assert.ok(Object.is(copied[0]!.createdAt,-0));rows[1]!.baselineTurnIds=['mutated'];assert.deepEqual(copied[1]!.baselineTurnIds,['second','first']);
 assert.deepEqual(captureReceiverTerminal(observed,{kind:'ok',value:false}),{kind:'ok',value:false});
 assert.deepEqual(captureReceiverTerminal(mapping,{kind:'ok',value:'\0🙂'}),{kind:'ok',value:'\0🙂'});
 for(const channel of [null,0n]){const q=captureReceiverOperation({op:'channel-mapping',channel});assert.deepEqual(captureReceiverTerminal(q,{kind:'ok',value:null}),{kind:'ok',value:null});assert.throws(()=>captureReceiverTerminal(q,{kind:'ok',value:''}),TypeError);}
 assert.deepEqual(captureReceiverTerminal(chunk,{kind:'ok',value:null}),{kind:'ok',value:null});
 for(const value of [undefined,false,[],{}])assert.throws(()=>captureReceiverTerminal(chunk,{kind:'ok',value}),TypeError);
 for(const value of [[{...job(),extra:1}],[{...job(),baselineTurnIds:[{}]}],Array(1),[{...job(),prompt:{nested:true}}]])assert.throws(()=>captureReceiverTerminal(jobs,{kind:'ok',value}),TypeError);
});
test('full original native read success budget is independent of new transport wrapper',()=>{
 const row={...job(),prompt:''},base=boundedSerdeByteCount({ok:true,value:[row]},RECEIVER_LIMITS.readSuccessBytes)!;
 row.prompt='a'.repeat(RECEIVER_LIMITS.readSuccessBytes-base);
 const frame=receiverFrame(epoch,{kind:'terminal',id:1,operation:'all-jobs',result:{kind:'ok',value:[row]}});
 assert.equal(captureReceiverReply(frame,epoch,jobs).kind,'terminal');row.prompt+='a';assert.throws(()=>captureReceiverReply(frame,epoch,jobs),TypeError);
});
test('known store diagnostics round-trip through original error without source exception text',()=>{
 const diagnostics:NativeStoreReadDiagnostic[]=[{kind:'Json'},{kind:'Integrity'},{kind:'InvalidQueueState'},{kind:'UnsupportedVersion',found:9n,supported:8n},{kind:'Database',errcode:11},{kind:'ScopeCleanup',errors:[{kind:'Json'},{kind:'Database',errcode:null}]}];
 for(const diagnostic of diagnostics)for(const operation of [observed,jobs,mapping]){
  const failure=projectReceiverFailure(operation,new NativeStoreReadError(diagnostic));assert.deepEqual(failure,{kind:'store',diagnostic});
  const error=terminalFailure(operation,failure);assert.ok(error instanceof NativeStoreReadError);assert.deepEqual(error.diagnostic,diagnostic);
 }
 assert.throws(()=>captureReceiverTerminal(jobs,{kind:'error',failure:{kind:'store',diagnostic:{kind:'Json',message:'SQL'}}}),TypeError);
});
test('native unavailable categories are operation-specific original wrappers',()=>{
 const values=[[observed,new NativeControlEvidenceUnavailable(new Error('private path')),'Observed'],[jobs,new NativeQueueReadUnavailableError('List',new Error('SQL')),'List'],[mapping,new NativePromptIntakeUnavailableError('MirrorTarget',new Error('row')),'MirrorTarget']] as const;
 for(const [operation,error,source] of values){const failure=projectReceiverFailure(operation,error);assert.deepEqual(failure,{kind:'native-unavailable',source});const restored=terminalFailure(operation,failure) as Error;assert.equal(Object.getPrototypeOf(restored),Object.getPrototypeOf(error));assert.ok(!String(restored.cause).includes('private path'));}
 assert.deepEqual(projectReceiverFailure(jobs,new NativeQueueReadUnavailableError('Eligible',new Error())),{kind:'unclassified-read-failure'});
 assert.deepEqual(projectReceiverFailure(observed,new NativeQueueReadUnavailableError('List',new Error())),{kind:'unclassified-read-failure'});
 for(const source of ['Observed','MirrorTarget'])assert.throws(()=>captureReceiverTerminal(jobs,{kind:'error',failure:{kind:'native-unavailable',source}}),TypeError);
});
test('admission failure reconstruction is diagnostic and exact original classes only',()=>{
 for(const operation of [observed,jobs,mapping,chunk])for(const [error,reason] of [[new OwnedWorkerBusyError(),'Busy'],[new OwnedWorkerBudgetError(),'Budget']] as const){
  const failure=projectReceiverFailure(operation,error);assert.deepEqual(failure,{kind:'admission-unavailable',reason});assert.equal(Object.getPrototypeOf(terminalFailure(operation,failure)),Object.getPrototypeOf(error));
 }
 for(const error of [Object.assign(new Error('private'),{name:'OwnedWorkerBusyError'}),Object.create(OwnedWorkerBusyError.prototype),new TypeError('private'),new RangeError('private')])assert.deepEqual(projectReceiverFailure(jobs,error),{kind:'unclassified-read-failure'});
});
test('original chunk failure semantics and receipt operation survive reconstruction',()=>{
 const held=projectReceiverFailure(chunk,new CompletionHeldError('private held text'));assert.deepEqual(held,{kind:'held'});assert.ok(isCompletionHeld(terminalFailure(chunk,held)));
 const delivery=projectReceiverFailure(chunk,new CompletionDeliveryError('private error'));assert.deepEqual(delivery,{kind:'delivery'});assert.ok(terminalFailure(chunk,delivery) instanceof CompletionDeliveryError);
 for(const operation of ['Begin','Confirm','Release','Block'] as const){const failure=projectReceiverFailure(chunk,new CompletionReceiptUnconfirmedError(operation,new Error('private')));assert.deepEqual(failure,{kind:'receipt-unconfirmed',operation});const restored=terminalFailure(chunk,failure);assert.ok(restored instanceof CompletionReceiptUnconfirmedError);assert.equal(restored.operation,operation);}
 const forged=Object.assign(new Error('private'),{name:'CompletionHeldError',kind:'Held'});assert.deepEqual(projectReceiverFailure(chunk,forged),{kind:'unclassified-chunk-failure'});
 const malformed=new CompletionReceiptUnconfirmedError('Begin',new Error());Object.defineProperty(malformed,'operation',{get(){assert.fail('getter must not run');}});assert.deepEqual(projectReceiverFailure(chunk,malformed),{kind:'unclassified-chunk-failure'});
 assert.ok(terminalFailure(chunk,{kind:'unclassified-chunk-failure'}) instanceof PersistentPromptChunkUnclassifiedError);
 const read=terminalFailure(observed,{kind:'unclassified-read-failure'});assert.ok(read instanceof PersistentPromptReadUnclassifiedError);assert.equal(read.operation,'observed-completion');
});
test('read/chunk failure tags never cross operation families',()=>{
 const chunkFailures:ReceiverFailure[]=[{kind:'held'},{kind:'delivery'},{kind:'cancelled'},{kind:'receipt-unconfirmed',operation:'Confirm'},{kind:'unclassified-chunk-failure'}];
 for(const failure of chunkFailures)assert.throws(()=>captureReceiverTerminal(jobs,{kind:'error',failure}),TypeError);
 for(const failure of [{kind:'store',diagnostic:{kind:'Json'}},{kind:'native-unavailable',source:'Observed'},{kind:'unclassified-read-failure'}])assert.throws(()=>captureReceiverTerminal(chunk,{kind:'error',failure}),TypeError);
 for(const failure of [{kind:'delivery',message:'raw'},{kind:'receipt-unconfirmed',operation:'Other'},{kind:'admission-unavailable',reason:'Other'},{kind:'unknown'}])assert.throws(()=>captureReceiverTerminal(chunk,{kind:'error',failure}),TypeError);
});
test('cancellation maps only the exact matching main reason to the aborted caller-local reason',()=>{
 const main=new AbortController(),local=new AbortController(),reason=new Error('private main reason'),localReason={local:true};main.abort(reason);local.abort(localReason);
 const failure=projectReceiverFailure(chunk,reason,main.signal);assert.deepEqual(failure,{kind:'cancelled'});assert.equal(thrown(()=>throwReceiverFailure(chunk,failure,local.signal)),localReason);
 assert.deepEqual(projectReceiverFailure(chunk,new Error('private main reason'),main.signal),{kind:'unclassified-chunk-failure'});
 assert.deepEqual(projectReceiverFailure(jobs,reason,main.signal),{kind:'unclassified-read-failure'});
 assert.throws(()=>throwReceiverFailure(chunk,failure,new AbortController().signal),TypeError);assert.throws(()=>throwReceiverFailure(chunk,failure),TypeError);
 assert.deepEqual(captureReceiverTerminal(chunk,{kind:'ok',value:null}),{kind:'ok',value:null});
});
test('data frames have exact wrappers/bodies and terminal tags bind full expected operations',()=>{
 const commands:ReceiverCommand[]=[{kind:'ready'},{kind:'submit',id:1,operation:chunk},{kind:'cancel',id:1},{kind:'ack-terminal',id:1},{kind:'close'},{kind:'ack-close'}];
 for(const body of commands)assert.deepEqual(captureReceiverCommand(receiverFrame(epoch,body),epoch),body);
 const replies:ReceiverReply[]=[{kind:'ready'},{kind:'terminal',id:1,operation:'server-prompt-chunk',result:{kind:'ok',value:null}},{kind:'retired',id:1},{kind:'closed'}];
 for(const body of replies)assert.deepEqual(captureReceiverReply(receiverFrame(epoch,body),epoch,chunk),body);
 for(const frame of [{version:2,epoch,body:{kind:'ready'}},{version:1,epoch:'b'.repeat(32),body:{kind:'ready'}},{version:1,epoch,body:{kind:'ready'},extra:1},{version:1,epoch,body:{kind:'ready',extra:1}},{version:1,epoch,body:{kind:'status'}}])assert.throws(()=>captureReceiverCommand(frame,epoch),TypeError);
 for(const id of [0,-0,-1,1.5,RECEIVER_LIMITS.maxId+1,1n,'1'])assert.throws(()=>captureReceiverCommand({version:1,epoch,body:{kind:'cancel',id}},epoch),TypeError);
 const frame=receiverFrame(epoch,replies[1]!);assert.throws(()=>captureReceiverReply(frame,epoch),TypeError);assert.throws(()=>captureReceiverReply(frame,epoch,observed),TypeError);
 assert.throws(()=>captureReceiverReply({version:1,epoch,body:{kind:'terminal',id:1,operation:'all-jobs',result:{kind:'ok',value:[],extra:1}}},epoch,jobs),TypeError);
});
test('control carries only one bounded ID value; sequencing remains endpoint-owned',()=>{
 for(const id of [0,1,RECEIVER_LIMITS.maxId]){assert.deepEqual(captureReceiverControlCommand(receiverFrame(epoch,{kind:'stop-and-join',id}),epoch),{kind:'stop-and-join',id});assert.deepEqual(captureReceiverControlReply(receiverFrame(epoch,{kind:'joined',id}),epoch),{kind:'joined',id});}
 for(const body of [{kind:'stop-and-join',id:-0},{kind:'stop-and-join',id:1,operation:'all-jobs'},{kind:'reopen',id:1},{kind:'stop-and-join',id:RECEIVER_LIMITS.maxId+1}])assert.throws(()=>captureReceiverControlCommand({version:1,epoch,body},epoch),TypeError);
 assert.throws(()=>captureReceiverControlReply({version:1,epoch,body:{kind:'joined',id:1,result:null}},epoch),TypeError);
});
test('descriptor requires exact passive inventory and two distinct genuine MessagePorts',()=>{
 // Local ports only: no post, socket, Worker, native adapter or database open.
 const data=new MessageChannel(),control=new MessageChannel();
 try{
  const descriptor={version:1,kind:'persistent-receiver-services-v1',epoch,data:data.port1,control:control.port1};
  const captured=captureReceiverDescriptor(descriptor);assert.equal(captured.data,data.port1);assert.equal(captured.control,control.port1);assert.ok(Object.isFrozen(captured));
  for(const altered of [{...descriptor,control:data.port1},{...descriptor,data:Object.create(MessagePort.prototype)},{...descriptor,data:new Proxy(data.port1,{})},{...descriptor,path:'/unused'},{...descriptor,epoch:epoch.toUpperCase()},{...descriptor,kind:'other'}])assert.throws(()=>captureReceiverDescriptor(altered),TypeError);
  let called=false;const getter=Object.defineProperty({...descriptor},'data',{enumerable:true,get(){called=true;return data.port1;}});assert.throws(()=>captureReceiverDescriptor(getter),TypeError);assert.equal(called,false);
 }finally{data.port1.close();data.port2.close();control.port1.close();control.port2.close();}
});
