import {stat} from 'node:fs/promises';
import {PortableAppServerSession,type PortableSessionConfig} from '../app-server/portable-session.ts';
import {runtimeResidentConfig} from '../runtime/discord-runtime/resident-config.ts';
import type {RuntimePaths} from '../runtime/runtime-paths/resolve.ts';
import {readThreadInventoryOffThread,resolveThreadReferenceOffThread} from '../codex-state/reference-reader.ts';
import {renderThreadList} from '../codex-state/context-reader.ts';
import {NativeBridgeStateOwner} from '../runtime/bridge-state-native.ts';
import {NativeArchiveWriter} from '../runtime/action-executor/archive-write-native.ts';
import {verifyArchivedScope} from '../runtime/action-executor/archive-persistence.ts';
import {readArchivedScopeOffThread} from '../codex-state/reference-reader.ts';
import {parseThreadState,THREAD_STATE_QUERY_LIMIT,THREAD_STATE_TOTAL_MS,THREAD_STATE_SINGLE_MS} from '../runtime/action-executor/thread-state-probe.ts';
import {serdeField} from '../app-server/value.ts';
export async function withAdminSession<T>(config:PortableSessionConfig,action:(session:PortableAppServerSession)=>Promise<T>,signal?:AbortSignal):Promise<T>{
 const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(new Error('Admin app-server startup deadline')),45000),combined=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
 let session:PortableAppServerSession|undefined;
 try{session=(await PortableAppServerSession.startObserved(config,()=>({value:null,dispose(){}}),()=> 'Admin provider diagnostic',combined)).session;}finally{clearTimeout(timer);}
 try{return await action(session);}finally{await session.dispose();}
}
const request=(server:PortableAppServerSession,method:string,params:unknown,signal?:AbortSignal,timeout=8000)=>server.request(method,params,timeout,undefined,signal);
export async function runThreadAdmin(paths:RuntimePaths,version:string,thread:string|undefined,limit:bigint,signal?:AbortSignal):Promise<string>{
 for(const p of [paths.stateDb,paths.mirrorDb])if(!(await stat(p)).isFile())throw new Error('Thread administration requires existing state and mirror databases');
 if(thread!==undefined&&!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(thread))throw new Error('archive-thread requires the exact UUID; aliases and row numbers are not accepted');
 if(limit<0n||limit>0xffffffffn)throw new Error('--limit must be a nonnegative u32');
 return withAdminSession(runtimeResidentConfig(paths,version),async server=>{
  const bridge=new NativeBridgeStateOwner(paths.bridgeState);
  if(thread===undefined){
   const threads=await readThreadInventoryOffThread(paths.stateDb,false,signal),states=new Map<string,string>(),end=performance.now()+THREAD_STATE_TOTAL_MS;
   for(const item of threads.slice(0,limit===0n?undefined:Number(limit))){signal?.throwIfAborted();const remaining=end-performance.now();let status='미확인 (서버 조회 한도 50개/전체 3초)';if(states.size<THREAD_STATE_QUERY_LIMIT&&remaining>0){try{const reply=await request(server,'thread/read',{threadId:item.id,includeTurns:false},signal,Math.max(1,Math.floor(Math.min(THREAD_STATE_SINGLE_MS,remaining))));status=parseThreadState(reply,item.id,new Date().toISOString());}catch{signal?.throwIfAborted();status='조회 실패: thread/read 응답 미확인';}}states.set(item.id,status);}
   const selected=await bridge.execute({kind:'Selected'},signal) as string|null;return renderThreadList(threads,selected,Number(limit),false,states,signal);
  }
  const descendants=async()=>{let cursor:string|null=null;const ids=new Set<string>(),cursors=new Set<string>();for(let page=0;page<=10;page++){
   const response=await request(server,'thread/list',{ancestorThreadId:thread,archived:false,limit:100n,cursor,sourceKinds:['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown']},signal);
   const data=serdeField(response,'data');if(!Array.isArray(data))throw new Error('Archive descendants are unconfirmed');for(const row of data){const id=serdeField(row,'id');if(typeof id!=='string'||!id||id!==id.trim()||id===thread||ids.has(id)||ids.size===100)throw new Error('Archive descendants are invalid or exceed bound');ids.add(id);}const next=serdeField(response,'nextCursor');if(next===null)return [...ids].sort();if(typeof next!=='string'||!next||cursors.has(next))throw new Error('Archive pagination unconfirmed');cursors.add(next);cursor=next;
  }throw new Error('Archive pagination exceeds bound');};
  const children=await descendants(),scope=[...children,thread];
  for(const id of scope){const stored=await resolveThreadReferenceOffThread(paths.stateDb,id,null,false,signal);if(stored.id!==id)throw new Error('Archive target no longer exists exactly');}
  const writer=new NativeArchiveWriter(paths.mirrorDb),operation=await writer.execute({kind:'Reserve',scope,own:null},signal);if(operation===null)throw new Error('Archive reservation unconfirmed');
  // This CLI invocation is the local authority. It never fabricates a Discord
  // ingress. Persistent fences exclude bot work and survive uncertain effects.
  for(const id of scope){const resumed=await request(server,'thread/resume',{threadId:id},signal,60000);if(serdeField(serdeField(resumed,'thread'),'id')!==id)throw new Error('Archive resume identity differs; reservation retained');const read=await request(server,'thread/read',{threadId:id,includeTurns:false},signal);if(serdeField(serdeField(read,'thread'),'id')!==id||serdeField(serdeField(serdeField(read,'thread'),'status'),'type')!=='idle')throw new Error('Archive requires confirmed idle scope; reservation retained');}
  if(JSON.stringify(await descendants())!==JSON.stringify(children))throw new Error('Archive scope changed; reservation retained');
  await request(server,'thread/archive',{threadId:thread},signal,60000);
  await verifyArchivedScope(paths.stateDb,scope,signal,readArchivedScopeOffThread);await writer.execute({kind:'Verified',operation},signal);await bridge.execute({kind:'ClearScope',scope},signal);
  return `Archived Codex thread ${thread} (${scope.length} conversations, persisted state verified).`;
 },signal);
}
