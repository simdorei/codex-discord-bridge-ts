import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {quoteWindowsArgument} from '../runtime/windows/windows-window-process.ts';
import {OwnedPortableAppServerProcess} from '../app-server/portable-process.ts';
import {acquireWindowsSingletonOwner,releaseWindowsSingletonOwner} from '../runtime/windows/windows-singleton-owner.ts';
export function trayPayload(root:string,entry:string,node:string):string{
 const args=(...parts:string[])=>[entry,...parts,'--runtime-root',root].map(quoteWindowsArgument).join(' ');
 return Buffer.from(JSON.stringify({root,node,status:args('--supervisor-status'),restart:args('--supervisor-control','restart'),force:args('--supervisor-control','force_restart')})).toString('base64');
}
export async function runWindowsTray(root:string,entry:string,signal:AbortSignal):Promise<void>{
 const guard=acquireWindowsSingletonOwner(join(root,'.cdr-ts-tray'));let child:OwnedPortableAppServerProcess|undefined;const streams:Promise<void>[]=[];
 try{
  const script=fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../scripts/codex-discord-tray.ps1':'../../../scripts/codex-discord-tray.ps1',import.meta.url));
  child=await OwnedPortableAppServerProcess.spawn({executable:join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),arguments:['-NoLogo','-NoProfile','-NonInteractive','-Sta','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',script,'-Payload',trayPayload(root,entry,process.execPath)],cwd:root,environment:{}});
  await child.input.shutdown();const drain=async(source:OwnedPortableAppServerProcess['stdout'])=>{let size=0;for(;;){const bytes=await source.readChunk();if(bytes===null)return;size+=bytes.length;if(size>65536)throw Error('Tray diagnostic budget exceeded');process.stderr.write(bytes);}};
  streams.push(drain(child.stdout),drain(child.stderr));await Promise.all([...streams,child.wait(signal)]);if(child.exitCode!==0)throw Error('Tray exited unsuccessfully');
 }finally{if(child)await child.forceDispose();await Promise.allSettled(streams);const released=await releaseWindowsSingletonOwner(guard);if(released.closure!=='closed')throw Error('Tray ownership release is unconfirmed');}
}
