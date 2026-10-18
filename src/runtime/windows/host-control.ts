import {join} from 'node:path';
import {requestSupervisor} from './supervisor.ts';
import {runOwnedCommand} from './owned-command.ts';
import type {ActionResult} from '../action-result.ts';
export function createWindowsHostControl(root:string,runtimeId:string,enableReboot:boolean){
 return async(action:'ForceRestartCodex'|'HostReboot',signal?:AbortSignal):Promise<ActionResult>=>{
  signal?.throwIfAborted();let text:string;
  if(action==='ForceRestartCodex'){const dispatched=await requestSupervisor(root,'force_restart',signal,runtimeId);text=`봇·앱서버 강제 재시작을 요청했습니다. 진행 중이던 요청은 자동 재전송하지 않습니다.\nreceipt: ${dispatched.receipt}`;}
  else{if(!enableReboot)throw new Error('host commands are disabled by DISCORD_ENABLE_HOST_COMMANDS');const result=await runOwnedCommand({executable:join(process.env.SystemRoot??'C:\\Windows','System32','shutdown.exe'),arguments:['/r','/t','5','/c','Codex Discord Remote requested restart'],environment:{}},{timeoutMs:3000,maxBytes:65536,...(signal===undefined?{}:{signal})});if(result.exitCode!==0)throw new Error('Windows host restart was not accepted');text='Windows host restart scheduled in 5 seconds.';}
  return{text,waitsForFinal:false,ui:null};
 };
}
