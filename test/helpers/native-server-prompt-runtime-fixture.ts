import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import assert from 'node:assert/strict';
import {promptFixture,callPromptFixture} from './server-prompt-fixture.ts';
import {PortableResidentLifecycle} from '../../src/app-server/portable-resident-lifecycle.ts';
import {RuntimeCommandExecutor} from '../../src/runtime/action-executor/command-executor.ts';
import {BridgeState} from '../../src/runtime/bridge-state.ts';
import {QueueStartCoordinator} from '../../src/runtime/queue-runner/start-coordinator.ts';
import {AppServerTurnBackend} from '../../src/runtime/app-server-turn-backend.ts';
import {AdmissionGate} from '../../src/admission/drain-gate.ts';
import {InteractionAccessPolicy} from '../../src/discord/interaction-access.ts';
import {pendingServerRequestEqual} from '../../src/app-server/server-request-state.ts';
export async function promptRuntimeFixture(run:(f:ReturnType<typeof setupPromptRuntime>)=>Promise<void>,input:Parameters<typeof promptFixture>[1]={}) {
 await promptFixture(async(path,server,request)=>{
  const f=setupPromptRuntime(path,server);await run(f);assert.equal(f.queue.locks.activeTargetCount,0);
  assert.deepEqual(await callPromptFixture(server,'answers'),[]);const pending=server.pendingServerRequests('t');assert.equal(pending.length,1);assert.ok(pendingServerRequestEqual(pending[0]!,request));
 },input);
}
export function setupPromptRuntime(path:string,server:PortableResidentLifecycle) {
 const codex=join(dirname(path),'codex.sqlite'),bridgePath=join(dirname(path),'bridge.json'),db=new DatabaseSync(codex);
 try{db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES('t','Target','/tmp',1,0,0)");}finally{db.close();}
 const bridge=new BridgeState(bridgePath);bridge.setSelectedThreadId('t');const gate=new AdmissionGate(),backend=new AppServerTurnBackend(server,()=> 'fixture',{resumeTimeoutMs:1000,historyTimeoutMs:1000}),queue=new QueueStartCoordinator(path,backend,{admission:gate}),executor=new RuntimeCommandExecutor({paths:{state:codex,mirror:path,bridge:bridgePath},bridge,server,backend,queue,render:()=> 'fixture',preparePrompt:async p=>p,mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:1000}),policy=new InteractionAccessPolicy({allowAllChannels:false,allowedChannelIds:[1n],allowedUserIds:[2n],mirroredChannelIds:[]});
 const reports:string[]=[],options={config:{attachmentsEnabled:false,attachmentMaxBytes:100n,attachmentTextInlineMaxBytes:100n},attachmentRoot:dirname(path),attachmentTransport:{async get(){throw Error('unexpected attachment');}},attachmentReport:()=>{},classification:{enableMessageContent:true,plainAskMentionUserIds:new Set<bigint>()},report:(code:string)=>{reports.push(code);},now:()=>102};
 return {path,server,queue,gate,executor,options,reports,startup:{owner:server,queue,executor,policy}};
}
