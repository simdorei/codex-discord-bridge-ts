import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {dirname,join} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {encodeWindowsBitmapPng} from '../../src/runtime/windows/png.ts';
import {WebSocketServer} from 'ws';
import {storeFixture} from '../helpers/store-fixture.ts';
import {SecretToken} from '../../src/config/remote.ts';
import {RemoteAgentStatus,RemoteAgentControl} from '../../src/remote-agent/agent-state.ts';
import {prepareConfiguredManagedRemoteAgent,runManagedRemoteAgent,managedRemoteSnapshot,type ConfiguredManagedRemoteConfiguration} from '../../src/remote-agent/managed-agent.ts';
import {openNativeRemoteProject} from '../../src/remote-agent/native-project.ts';
import {writeWindowsRestartHandoff,claimWindowsRestartHandoff} from '../../src/remote-agent/restart-handoff-persistence.ts';
test('configured remote handshake uses actual native project, file CAS, 5 MiB image ingress and protected handoff', {skip:process.platform!=='win32',timeout:60000},()=>storeFixture(async path=>{
 const root=dirname(path),project=join(root,'project');await mkdir(project);const ws=new WebSocketServer({host:'127.0.0.1',port:0});await once(ws,'listening');
 const png=encodeWindowsBitmapPng(1024,512,randomBytes(1024*512*4));assert.ok(png.length>1048576);await writeFile(join(project,'shot.png'),png);
 const upload=Buffer.alloc(5242880);png.copy(upload);
 const bridgeUrl=`ws://127.0.0.1:${(ws.address() as {port:number}).port}`,binding={bridgeUrl,deviceId:'configured-fixture'},file=join(root,'handoff','binding.json'),now=()=>({seconds:BigInt(Math.floor(Date.now()/1000)),nanosecond:0n}),expires=()=>({...now(),seconds:now().seconds+300n});
 const projectBinding=Object.freeze({threadId:'fixture-thread',root:project,expiresAt:Object.freeze(expires())});await writeWindowsRestartHandoff(file,Object.freeze([projectBinding]),binding,now());
 const stop=new AbortController(),control=new RemoteAgentControl(),received:any[]=[];let failure:unknown;
 ws.on('connection',(peer,req)=>{assert.equal(req.headers.authorization,'Bearer configured-fixture-secret');peer.on('message',bytes=>{try{
  const value=JSON.parse(bytes.toString());received.push(value);const command=(type:string,extra:object={})=>JSON.stringify({type,request_id:type,thread_id:'fixture-thread',computer_session_id:'abcdefghijklmnop',deadline_at:new Date(Date.now()+60000).toISOString(),...extra});
  if(value.type==='hello'){peer.send('{"type":"hello_ack"}');peer.send(command('project_session',{computer_session_generation:1}));}
  else if(value.type==='project_session_result')peer.send(command('write_file',{path:'from-remote.txt',content:'configured remote works',expected_sha256:null}));
  else if(value.type==='write_file_result')peer.send(command('write_file',{request_id:'conflict',path:'from-remote.txt',content:'must not overwrite',expected_sha256:null}));
  else if(value.type==='operation_error'&&value.request_id==='conflict'&&value.error_code==='fileconflict')peer.send(command('read_file',{path:'from-remote.txt',start_line:1,max_lines:20}));
  else if(value.type==='read_file_result'){assert.equal(value.output.content,'configured remote works');peer.send(command('project_operation',{operation:{kind:'retrieve_image',path:'shot.png'}}));}
  else if(value.type==='project_operation_result'&&value.request_id==='project_operation'){assert.equal(value.output.kind,'image_retrieve');assert.equal(value.output.data_base64,png.toString('base64'));peer.send(command('project_operation',{request_id:'upload',operation:{kind:'save_image',path:'uploaded.png',data_base64:upload.toString('base64'),overwrite:false}}));}
  else if(value.type==='project_operation_result'&&value.request_id==='upload'){assert.equal(value.output.kind,'image_save');assert.equal(value.output.image.size_bytes,5242880);peer.send(command('project_operation',{request_id:'oversize',operation:{kind:'save_image',path:'too-large.png',data_base64:Buffer.concat([upload,Buffer.from([0])]).toString('base64'),overwrite:false}}));}
  else if(value.type==='operation_error'&&value.request_id==='oversize'){assert.notEqual(value.error_code,'bridge_busy');peer.send(command('project_info'));}
  else if(value.type==='project_info_result'){control.requestRestartHandoff();stop.abort();}
  else if(value.type==='operation_error'){failure=value;stop.abort();}
 }catch(e){failure=e;stop.abort();}});});
 const config:ConfiguredManagedRemoteConfiguration={kind:'ConfiguredManagedRemote',socket:{bridgeUrl,deviceId:binding.deviceId,deviceToken:new SecretToken('configured-fixture-secret')},reconnectDelaySeconds:0n,status:new RemoteAgentStatus(),control,
  dispatcher:{openProject:p=>openNativeRemoteProject(p,process.execPath),nowUtc:now,nowMonotonic:()=>process.hrtime.bigint(),maxResultBytes:12000000},
  handoff:{kind:'WindowsProtectedBindingPorts',restore:()=>claimWindowsRestartHandoff(true,file,binding,now()),protect:(projects,at)=>writeWindowsRestartHandoff(file,projects,binding,at)},disconnected:async()=>{}};
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const owner=await prepareConfiguredManagedRemoteAgent(config,stop.signal);timer=setTimeout(()=>stop.abort(new Error('Fixture deadline')),45000);await runManagedRemoteAgent(owner,stop.signal);assert.equal(failure,undefined,JSON.stringify(failure));assert.equal(await readFile(join(project,'from-remote.txt'),'utf8'),'configured remote works');assert.deepEqual(await readFile(join(project,'uploaded.png')),upload);assert.equal(received.filter(v=>v.type==='project_info_result').length,1);assert.equal(managedRemoteSnapshot(owner).phase,'closed');assert.equal(managedRemoteSnapshot(owner).handoffPrepared,true);assert.equal(received.filter(v=>v.type==='write_file_result').length,1);const restored=await claimWindowsRestartHandoff(true,file,binding,now());assert.equal(restored.length,1);assert.equal(restored[0]!.root,project);assert.deepEqual(await claimWindowsRestartHandoff(true,file,binding,now()),[]);
 }finally{if(timer)clearTimeout(timer);stop.abort();for(const peer of ws.clients)peer.terminate();await new Promise<void>(resolve=>ws.close(()=>resolve()));}
}));
