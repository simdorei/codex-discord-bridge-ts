import {RemoteFileFailure} from './error.ts';
import {types} from 'node:util';import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../../runtime/owned-worker-slot.ts';
import {RemoteReadOwner} from './read-owner.ts';import {validateRemoteRelativePath,remoteRelativeText} from './path-policy.ts';import {selectRemoteTextLines} from './line-selection.ts';
const slot=new OwnedWorkerSlot();let occupied=false;
export interface RemoteReadFileOutput{readonly path:string;readonly content:string;readonly sha256:string;readonly start_line:bigint;readonly end_line:bigint;readonly total_lines:bigint;readonly truncated:boolean;readonly redacted:boolean;}
/** Borrow an already-authorized native owner. One bounded request, no queue.
 * Read/close joins precede CPU rendering; stop waits accepted native work and
 * terminates/joins pure rendering. Not registered as remote project permission. */
export async function readRemoteFile(owner:RemoteReadOwner,relative:string,start:bigint,maxLines:number,signal?:AbortSignal):Promise<RemoteReadFileOutput>{
 signal?.throwIfAborted();validateRemoteRelativePath(relative,'posix');selectRemoteTextLines('',start,maxLines);
 if(types.isProxy(owner))throw new TypeError('Expected owned project reader');if(occupied)throw new OwnedWorkerBusyError();occupied=true;
 try{
  const bytes=await RemoteReadOwner.prototype.readBytes.call(owner,relative);signal?.throwIfAborted();const path=remoteRelativeText(relative);
  const pending=slot.runCpu(new URL('./read-file-worker.ts',import.meta.url),{bytes,path,start,maxLines},1000,signal),joined=slot.join();let result:unknown;
  try{result=await pending;}finally{await joined;}signal?.throwIfAborted();
  if(result===null||typeof result!=='object'||!Object.hasOwn(result,'ok'))throw new Error('Invalid remote file result');
  const envelope=result as {ok:unknown;kind?:unknown;output?:unknown};if(envelope.ok!==true){if(envelope.kind==='Encoding')throw new RemoteFileFailure('Encoding',relative,'file is not UTF-8 text');throw new Error('Remote file output processing failed');}
  const output=envelope.output;if(output===null||typeof output!=='object')throw new Error('Invalid remote file output');const v=output as RemoteReadFileOutput;
  if(v.path!==path||typeof v.content!=='string'||Buffer.byteLength(v.content)>2097152||typeof v.sha256!=='string'||!/^\p{ASCII_Hex_Digit}{64}$/u.test(v.sha256)||typeof v.truncated!=='boolean'||typeof v.redacted!=='boolean')throw new Error('Invalid remote file output fields');
  for(const number of [v.start_line,v.end_line,v.total_lines])if(typeof number!=='bigint'||number<0n||number>18446744073709551615n)throw new Error('Invalid remote file output line range');
  return Object.freeze(v);
 }finally{occupied=false;}
}
