import {spawn} from 'node:child_process';
import {types} from 'node:util';
import {isAbsolute} from 'node:path';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {parseSerdeValue} from '../../core/serde-json-parse.ts';
export interface ControllerProcessInput{readonly executable:string;readonly arguments:readonly string[];readonly cwd:string;readonly timeoutMs:number;readonly maxBytes:number;}
export class ControllerProcessError extends Error{
 constructor(readonly kind:'spawn'|'timeout'|'aborted'|'output'|'exit'|'decode'|'cleanup',cause?:unknown){super(`Recovery controller invocation failed (${kind}); inspect durable evidence before retrying`,{cause});this.name='ControllerProcessError';}
}
function text(value:unknown):string{requireDiscordText(value);if(value.includes('\0')||Buffer.byteLength(value)>32768)throw new TypeError('Invalid controller process text');return value;}
function capture(input:ControllerProcessInput){
 const executable=text(own(input,'executable')),cwd=text(own(input,'cwd')),args=own(input,'arguments'),timeoutMs=own(input,'timeoutMs'),maxBytes=own(input,'maxBytes');
 if(!isAbsolute(executable)||!isAbsolute(cwd)||!Array.isArray(args)||types.isProxy(args)||args.length>32)throw new TypeError('Expected absolute controller paths and bounded arguments');
 const argv:string[]=[];for(let i=0;i<args.length;i++)argv.push(text(own(args,String(i))));
 if(typeof timeoutMs!=='number'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>20000||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1048576)throw new TypeError('Invalid controller process budget');
 return {executable,cwd,argv,timeoutMs,maxBytes};
}
/** Bounded direct-child transport, not a Windows process-tree owner. No shell,
 * retries, inherited stdin, raw-output errors, or receipt-as-completion claim.
 * Production recovery still requires pinned TS controller assets and native
 * process identity/descendant custody. This helper alone must not enable it. */
export async function invokeControllerProcess(input:ControllerProcessInput,signal?:AbortSignal):Promise<unknown>{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected controller abort signal');
 const config=capture(input);signal?.throwIfAborted();
 let child:ReturnType<typeof spawn>;try{child=spawn(config.executable,config.argv,{cwd:config.cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(error){throw new ControllerProcessError('spawn',error);}
 let failure:ControllerProcessError|undefined,total=0,closed=false;const stdout:Buffer[]=[];
 let resolveClose!:()=>void;const terminal=new Promise<void>(resolve=>{resolveClose=resolve;});
 let exitCode:number|null=null,exitSignal:NodeJS.Signals|null=null;
 const kill=()=>{if(child.exitCode===null&&child.signalCode===null){try{child.kill('SIGKILL');}catch(error){failure??=new ControllerProcessError('cleanup',error);}}};
 const fail=(error:ControllerProcessError)=>{failure??=error;kill();};
 child.on('error',error=>fail(new ControllerProcessError('spawn',error)));
 child.once('close',(code,sig)=>{closed=true;exitCode=code;exitSignal=sig;resolveClose();});
 const data=(bytes:Buffer,isStdout:boolean)=>{if(failure!==undefined)return;total+=bytes.byteLength;if(total>config.maxBytes){fail(new ControllerProcessError('output'));return;}if(isStdout)stdout.push(Buffer.from(bytes));};
 child.stdout?.on('data',(bytes:Buffer)=>data(bytes,true));child.stderr?.on('data',(bytes:Buffer)=>data(bytes,false));
 child.stdout?.on('error',error=>fail(new ControllerProcessError('output',error)));child.stderr?.on('error',error=>fail(new ControllerProcessError('output',error)));
 const abort=()=>fail(new ControllerProcessError('aborted',signal?.reason));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
 // If descendants retain pipes after the direct child exits, do not certify a
 // joined tree. Destroy owned streams and return a cleanup failure, bounded.
 const timeout=setTimeout(()=>fail(new ControllerProcessError('timeout')),config.timeoutMs);
 const cleanup=new Promise<void>(resolve=>{cleanupTimer=setTimeout(()=>{if(!closed){failure??=new ControllerProcessError('cleanup');kill();child.stdout?.destroy();child.stderr?.destroy();child.unref();}resolve();},config.timeoutMs+2000);});
 try{
  await Promise.race([terminal,cleanup]);
  if(!closed)throw failure??new ControllerProcessError('cleanup');
  if(failure!==undefined)throw failure;if(exitCode!==0||exitSignal!==null)throw new ControllerProcessError('exit');
  signal?.throwIfAborted();try{return parseSerdeValue(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(stdout)));}catch(error){throw new ControllerProcessError('decode',error);}
 }finally{clearTimeout(timeout);if(cleanupTimer!==undefined)clearTimeout(cleanupTimer);signal?.removeEventListener('abort',abort);}
}
