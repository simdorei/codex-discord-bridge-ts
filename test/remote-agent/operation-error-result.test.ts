import {it} from 'node:test';
import assert from 'node:assert/strict';
import {RemoteOperationFailure,captureRemoteOperationFailure,type RemoteOperationFailureInput} from '../../src/remote-agent/operation-failure.ts';
import {remoteOperationErrorResult,settledRemoteOperationFailure,takeRemoteOperationFailure} from '../../src/remote-agent/operation-error-result.ts';
import {RemoteFileFailure} from '../../src/remote-agent/files/error.ts';
import {redactRemoteText} from '../../src/remote-agent/files/redaction.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {parseCoreRequest} from '../../src/remote-agent/core-request.ts';
import {parseTerminalRequest} from '../../src/remote-agent/terminal-request.ts';
import {parseGatewayCommand} from '../../src/remote-agent/gateway-command.ts';
import {parseBridgeInboundMessage} from '../../src/remote-agent/bridge-inbound.ts';
import {serializeBridgeInboundMessage} from '../../src/remote-agent/bridge-serialize.ts';
const failure=(input:RemoteOperationFailureInput)=>new RemoteOperationFailure(input);
const signal=()=>new AbortController().signal;
const cancelled='The remote project request was cancelled because the local bridge disconnected.';
const fallback='The remote operation error could not be safely rendered.';

it('nested File preserves all source codes except Command File which remains projectcommand',async()=>{
 const pairs=[['UnsafePath','unsafeprojectpath'],['UnsafePattern','unsafeprojectpath'],['Size','projectfilesize'],['Encoding','projectfileencoding'],['Conflict','fileconflict'],['Limit','projectfilelimit'],['Io','projectfile']] as const;
 for(const [kind,code] of pairs){const error=new RemoteFileFailure(kind,'fixture','password=synthetic');
  for(const family of ['checkpoint','code','git','image','command'] as const){const result=await remoteOperationErrorResult('0009007199254740993',failure({family,failure:{kind:'File',error}}));assert.equal(result.error_code,family==='command'?'projectcommand':code);assert.equal(result.message,kind==='Io'?'password=[REDACTED]':'fixture: password=[REDACTED]');assert.equal(result.request_id,'0009007199254740993');assert.ok(Object.isFrozen(result));assert.deepEqual({...parseBridgeInboundMessage(serializeBridgeInboundMessage(result,10000),10000)},result);}
  const nested=failure({family:'image',failure:{kind:'Checkpoint',error:failure({family:'checkpoint',failure:{kind:'File',error}})}});assert.equal((await remoteOperationErrorResult('r',nested)).error_code,code);
 }
});
it('source family variants preserve exact codes and diagnostic formatting',async()=>{
 const cases:readonly [RemoteOperationFailureInput,string,string][]=[
  [{family:'checkpoint',failure:{kind:'Invalid',value:'cp_fixture'}},'projectcheckpoint','cp_fixture: invalid checkpoint record'],
  [{family:'checkpoint',failure:{kind:'Json',diagnostic:'synthetic JSON diagnostic'}},'projectcheckpoint','synthetic JSON diagnostic'],
  [{family:'checkpoint',failure:{kind:'Base64',diagnostic:'synthetic base64 diagnostic'}},'projectcheckpoint','synthetic base64 diagnostic'],
  [{family:'code',failure:{kind:'Cancelled'}},'request_cancelled',cancelled],
  [{family:'command',failure:{kind:'Manifest',path:'manifest.json',reason:'invalid manifest'}},'projectcommand','manifest.json: invalid manifest'],
  [{family:'command',failure:{kind:'Rejected',commandId:'test',reason:'rejected'}},'projectcommand','test: rejected'],
  [{family:'command',failure:{kind:'Process',diagnostic:'synthetic process failure'}},'projectcommand','synthetic process failure'],
  [{family:'git',failure:{kind:'Process',diagnostic:'synthetic process failure'}},'projectgit','synthetic process failure'],
  [{family:'git',failure:{kind:'Failed',reason:'failed'}},'projectgit','<git>: failed'],
  [{family:'git',failure:{kind:'TimedOut'}},'projectgit','<git>: Git command timed out'],
  [{family:'git',failure:{kind:'Cancelled'}},'projectgit','<git>: Git command was cancelled'],
  [{family:'image',failure:{kind:'Invalid',path:'test.png',reason:'invalid image'}},'projectimage','test.png: invalid image'],
  [{family:'image',failure:{kind:'Network',reason:'failed'}},'projectimage','<image-url>: failed'],
  [{family:'image',failure:{kind:'TimedOut'}},'projectimage','image request expired before it completed'],
  [{family:'image',failure:{kind:'Cancelled'}},'request_cancelled',cancelled],
  [{family:'terminal',failure:{kind:'EmptySession'}},'terminal_execution','session_id must not be empty'],
  [{family:'terminal',failure:{kind:'InvalidRoot'}},'terminal_execution','terminal root is not a directory'],
  [{family:'terminal',failure:{kind:'Closed'}},'terminal_execution','terminal session is closed'],
  [{family:'terminal',failure:{kind:'ForeignTerminal'}},'terminal_execution','terminal does not belong to this session'],
  [{family:'terminal',failure:{kind:'ActiveCommand'}},'terminal_execution','terminal already has an active command'],
  [{family:'terminal',failure:{kind:'Cancelled'}},'terminal_execution','terminal execution was cancelled'],
  [{family:'terminal',failure:{kind:'MissingExecutableOrDirectory'}},'terminal_execution','terminal executable or directory was not found'],
  [{family:'terminal',failure:{kind:'CloseTimeout'}},'terminal_execution','terminal process trees did not stop before close timed out'],
  [{family:'terminal',failure:{kind:'UnsupportedRequest'}},'terminal_execution','terminal window operation is not an execution request'],
  [{family:'terminal',failure:{kind:'Window',diagnostic:'synthetic window failure'}},'terminal_execution','synthetic window failure'],
  [{family:'terminal',failure:{kind:'Process',diagnostic:'synthetic process failure'}},'terminal_execution','synthetic process failure'],
  [{family:'terminal',failure:{kind:'Io',diagnostic:'synthetic IO failure'}},'terminal_execution','terminal path could not be resolved: synthetic IO failure'],
  [{family:'terminal',failure:{kind:'Deadline',failure:'Expired'}},'terminal_execution','The local project request expired before execution.'],
  [{family:'terminal',failure:{kind:'Deadline',failure:'Cancelled'}},'terminal_execution','The local project request was cancelled with its bridge connection.'],
 ];
 for(const [input,code,message] of cases){const result=await remoteOperationErrorResult('r',failure(input));assert.equal(result.error_code,code);assert.equal(result.message,message);}
 for(const [shell,debug] of [['auto','Auto'],['powershell','Powershell'],['cmd','Cmd'],['sh','Sh'],['bash','Bash']] as const)assert.equal((await remoteOperationErrorResult('r',failure({family:'terminal',failure:{kind:'ShellUnavailable',shell}}))).message,`requested terminal shell is unavailable: ${debug}`);
 const nested=failure({family:'image',failure:{kind:'Checkpoint',error:failure({family:'checkpoint',failure:{kind:'Invalid',value:'cp_fixture'}})}});assert.equal((await remoteOperationErrorResult('r',nested)).message,'cp_fixture: invalid checkpoint record');assert.equal((await remoteOperationErrorResult('r',nested)).error_code,'projectcheckpoint');
});
it('private capture ignores later input and nested Error mutation',async()=>{
 const input={family:'git' as const,failure:{kind:'Failed' as const,reason:'password=synthetic'}};const captured=failure(input);input.failure.reason='changed';assert.ok(Object.isFrozen(captured));assert.equal((await remoteOperationErrorResult('r',captured)).message,'<git>: password=[REDACTED]');
 const file=new RemoteFileFailure('Conflict','fixture','password=synthetic');const nested=failure({family:'checkpoint',failure:{kind:'File',error:file}});let hooks=0;for(const key of ['kind','message','reason','value'])Object.defineProperty(file,key,{get(){hooks++;throw 0;}});assert.equal((await remoteOperationErrorResult('r',nested)).message,'fixture: password=[REDACTED]');assert.equal(hooks,0);
});
it('foreign values, proxies, accessors, invalid variants and nested errors never gain typed semantics',async()=>{
 let hooks=0;const proxy=new Proxy({}, {get(){hooks++;throw 0;},getOwnPropertyDescriptor(){hooks++;throw 0;},getPrototypeOf(){hooks++;throw 0;}});const revoked=Proxy.revocable({},{});revoked.revoke();const accessor={get family(){hooks++;throw 0;}};
 for(const value of [proxy,revoked.proxy,{},Object.create(RemoteOperationFailure.prototype),new Error('password=synthetic'),null]){assert.equal(captureRemoteOperationFailure(value),null);await assert.rejects(remoteOperationErrorResult('r',value as RemoteOperationFailure),TypeError);}
 for(const value of [proxy,revoked.proxy,accessor,{family:'unknown',failure:{kind:'File'}},{family:'terminal',failure:{kind:'Deadline',failure:'unknown'}},{family:'terminal',failure:{kind:'ShellUnavailable',shell:'unknown'}},{family:'code',failure:{kind:'File',error:new Error('password=synthetic')}},{family:'image',failure:{kind:'Checkpoint',error:failure({family:'git',failure:{kind:'Cancelled'}})}}])assert.throws(()=>failure(value as RemoteOperationFailureInput),TypeError);assert.equal(hooks,0);
});
it('bounded valid text is redacted before the 1000-scalar wire cap; empty and occupied rendering fail safely',async()=>{
 const long=failure({family:'terminal',failure:{kind:'Window',diagnostic:'🧪'.repeat(1100)}});assert.equal((await remoteOperationErrorResult('r',long)).message,'🧪'.repeat(1000));
 for(const diagnostic of ['x'.repeat(65537),'\ud800'])assert.throws(()=>failure({family:'terminal',failure:{kind:'Window',diagnostic}}));
 assert.throws(()=>failure({family:'image',failure:{kind:'Invalid',path:'x'.repeat(40000),reason:'x'.repeat(40000)}}),RangeError);
 assert.equal((await remoteOperationErrorResult('r',failure({family:'terminal',failure:{kind:'Window',diagnostic:''}}))).message,fallback);
 const held=redactRemoteText('safe'),result=remoteOperationErrorResult('r',failure({family:'git',failure:{kind:'Failed',reason:'password=synthetic'}}));assert.equal(await held,'safe');assert.equal((await result).message,fallback);assert.equal(ownedWorkerUsage().Background,0);
});
it('owner cancellation wins before and during redaction, without reclassifying an uncancelled terminal deadline',async()=>{
 const typed=failure({family:'terminal',failure:{kind:'Deadline',failure:'Expired'}}),stop=new AbortController();stop.abort();assert.equal((await remoteOperationErrorResult('r',typed,stop.signal)).error_code,'request_cancelled');assert.equal(ownedWorkerUsage().Background,0);
 const later=new AbortController(),pending=remoteOperationErrorResult('r',typed,later.signal);later.abort();assert.equal((await pending).error_code,'request_cancelled');assert.equal(ownedWorkerUsage().Background,0);
 await assert.rejects(remoteOperationErrorResult('r',typed,new Proxy(stop.signal,{})),TypeError);await assert.rejects(remoteOperationErrorResult('r'.repeat(4097),typed),RangeError);
});
it('returned settled receipts are exact-request-bound, one-use, and not forgeable by shape or prototype',async()=>{
 const request=parseCoreRequest('{"kind":"repo_status"}',1000),typed=failure({family:'git',failure:{kind:'Cancelled'}}),receipt=settledRemoteOperationFailure(request,typed);
 for(const value of [{...receipt},new Proxy(receipt,{}),Object.create(Object.getPrototypeOf(receipt)),typed])assert.equal(await takeRemoteOperationFailure('r',request,value,signal()),null);
 assert.equal((await takeRemoteOperationFailure('owner-id',request,receipt,signal()))?.request_id,'owner-id');await assert.rejects(takeRemoteOperationFailure('r',request,receipt,signal()),/already consumed/);
 const crossed=settledRemoteOperationFailure(request,typed);await assert.rejects(takeRemoteOperationFailure('r',parseCoreRequest('{"kind":"repo_status"}',1000),crossed,signal()),/another request/);await assert.rejects(takeRemoteOperationFailure('r',request,crossed,signal()),/already consumed/);
 assert.throws(()=>settledRemoteOperationFailure(request,failure({family:'terminal',failure:{kind:'Closed'}})),/family differs/);assert.throws(()=>settledRemoteOperationFailure(new Proxy(request,{}),typed),TypeError);
});
it('every accepted operation family follows execution dispatch including the composite status contract',()=>{
 const core:readonly [object,RemoteOperationFailureInput['family']][]=[
  [{kind:'project_rules'},'code'],[{kind:'code_search',query:'q'},'code'],[{kind:'command_list'},'command'],[{kind:'command_run',command_id:'test'},'command'],[{kind:'repo_status'},'git'],[{kind:'repo_diff'},'git'],[{kind:'git_commit',message:'test',paths:['a']},'git'],[{kind:'git_push'},'git'],[{kind:'file_create',path:'a',content:'x'},'checkpoint'],[{kind:'file_apply_patch',changes:[{action:'create',path:'a',content:'x'}]},'checkpoint'],[{kind:'checkpoint_list'},'checkpoint'],[{kind:'checkpoint_show',checkpoint_id:'cp_0000000000000000'},'checkpoint'],[{kind:'checkpoint_restore',checkpoint_id:'cp_0000000000000000'},'checkpoint'],[{kind:'save_image',path:'a.png',data_base64:'AAAA'},'image'],[{kind:'save_image_from_url',path:'a.png',url:'https://example.test/a.png'},'image'],[{kind:'list_images'},'image'],[{kind:'retrieve_image',path:'a.png'},'image'],[{kind:'project_status'},'git'],[{kind:'project_status'},'code'],[{kind:'project_status'},'command']
 ];
 const errors={checkpoint:failure({family:'checkpoint',failure:{kind:'Invalid',value:'x'}}),code:failure({family:'code',failure:{kind:'Cancelled'}}),command:failure({family:'command',failure:{kind:'Process',diagnostic:'x'}}),git:failure({family:'git',failure:{kind:'Cancelled'}}),image:failure({family:'image',failure:{kind:'Cancelled'}}),terminal:failure({family:'terminal',failure:{kind:'Closed'}})};
 for(const [input,family] of core)assert.ok(settledRemoteOperationFailure(parseCoreRequest(JSON.stringify(input),10000),errors[family]));
 for(const kind of ['terminal_exec','terminal_window_open','terminal_window_list','terminal_window_close','terminal_window_capture','terminal_window_activate','terminal_window_type','terminal_window_keys','terminal_window_interrupt']){const input={kind,...(kind==='terminal_exec'?{command:'synthetic'}:{}),...(!['terminal_exec','terminal_window_open','terminal_window_list'].includes(kind)?{terminal_window_id:'termwin_0000000000000000'}:{}),...(['terminal_window_type','terminal_window_keys','terminal_window_interrupt'].includes(kind)?{observation_id:'twobs_0000000000000000'}:{}),...(kind==='terminal_window_type'?{text:'synthetic'}:{}),...(kind==='terminal_window_keys'?{keys:['ENTER']}:{} )};assert.ok(settledRemoteOperationFailure(parseTerminalRequest(JSON.stringify(input),10000),errors.terminal));}
 const write=parseGatewayCommand('{"type":"write_file","request_id":"r","thread_id":"t","deadline_at":"1970-01-01T00:03:20Z","path":"a","content":"x"}',10000,0);assert.equal(write.type,'write_file');if(write.type==='write_file')assert.ok(settledRemoteOperationFailure(write,errors.checkpoint));
});
