import {randomUUID} from 'node:crypto';
import {open,mkdir,rename,unlink,stat} from 'node:fs/promises';
import {dirname} from 'node:path';
import {joinRuntimePath} from '../runtime-paths/path-text.ts';
import {parseRustU64} from '../../config/remote.ts';
import {DrainFenceKey,DrainGateError,getDrainFenceKeyRecord} from '../../admission/owned-key.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
export const DRAIN_MARKER_NAMES=Object.freeze({identity:'.codex_discord_rust.drain.identity',prepare:'.codex_discord_rust.drain.prepare',ack:'.codex_discord_rust.drain.ack',restart:'.codex_discord_rust.restart',stop:'.codex_discord_rust.stop'});
export interface RuntimeMarker{readonly runtimeId:string;readonly processId:number}
export class DrainMarkerError extends Error{
 readonly kind:'Io'|'Malformed';readonly path:string;readonly reason:string|null;
 constructor(kind:DrainMarkerError['kind'],path:string,reason:string|null,cause?:unknown){super(kind==='Malformed'?`restart drain marker ${path} is malformed: ${reason}`:`could not access restart drain marker ${path}`,{cause});this.name='DrainMarkerError';this.kind=kind;this.path=path;this.reason=reason;}
}
const malformed=(path:string,reason:string)=>new DrainMarkerError('Malformed',path,reason);
function fields(text:string,path:string):Map<string,string>{
 requireDiscordText(text);requireDiscordText(path);if(Buffer.byteLength(text,'utf8')>4096)throw malformed(path,'marker exceeds 4096 bytes');const values=new Map<string,string>();
 let start=0;while(start<text.length){const newline=text.indexOf('\n',start),end=newline<0?text.length:newline;let line=text.slice(start,end);if(newline>=0&&line.endsWith('\r'))line=line.slice(0,-1);start=newline<0?text.length:newline+1;const at=line.indexOf('=');if(at<0)throw malformed(path,"line does not contain '='");const name=line.slice(0,at),value=line.slice(at+1);if(name===''||value===''||values.has(name))throw malformed(path,'field is empty or duplicated');values.set(name,value);}return values;
}
function field(values:Map<string,string>,key:string,path:string):string{const v=values.get(key);if(v===undefined)throw malformed(path,`missing ${key}`);return v;}
function requireField(values:Map<string,string>,key:string,want:string,path:string):void{if(field(values,key,path)!==want)throw malformed(path,`invalid ${key}`);}
export function parseRuntimeIdentityMarker(text:string,path:string):RuntimeMarker{
 const values=fields(text,path);requireField(values,'version','1',path);requireField(values,'state','open',path);const runtimeId=field(values,'runtime_id',path),pid=parseRustU64(field(values,'pid',path));if(pid===null||pid>4294967295n)throw malformed(path,'pid must be an unsigned integer');return Object.freeze({runtimeId,processId:Number(pid)});
}
export function parseRuntimeFenceMarker(text:string,path:string,expectedState:'sealed'|null=null):DrainFenceKey{
 const values=fields(text,path);requireField(values,'version','1',path);if(expectedState!==null){if(expectedState!=='sealed')throw new TypeError('Expected sealed marker state');requireField(values,'state',expectedState,path);}return DrainFenceKey.create(field(values,'runtime_id',path),field(values,'process_identity',path),field(values,'nonce',path));
}
function identity(marker:RuntimeMarker):RuntimeMarker{const runtimeId=own(marker,'runtimeId'),processId=own(marker,'processId');requireDiscordText(runtimeId as string);if(runtimeId===''||/[\r\n]/.test(runtimeId as string)||typeof processId!=='number'||!Number.isInteger(processId)||processId<0||processId>4294967295)throw new TypeError('Invalid runtime identity marker');return Object.freeze({runtimeId:runtimeId as string,processId});}
export function encodeRuntimeIdentityMarker(marker:RuntimeMarker):string{const m=identity(marker);return `version=1\nruntime_id=${m.runtimeId}\npid=${m.processId}\nstate=open\n`;}
export function encodeRuntimeAckMarker(key:DrainFenceKey):string{const record=getDrainFenceKeyRecord(key);if(record===null)throw new DrainGateError('InvalidKey');return `version=1\nruntime_id=${record.runtimeId}\nprocess_identity=${record.processIdentity}\nnonce=${record.nonce}\nstate=sealed\n`;}
function code(error:unknown):unknown{return error!==null&&typeof error==='object'?Object.getOwnPropertyDescriptor(error,'code')?.value:undefined;}
export interface DrainMarkerStore{
 prepareExists():Promise<boolean>;ackExists():Promise<boolean>;readIdentity():Promise<RuntimeMarker|null>;readPrepare():Promise<DrainFenceKey|null>;readAck():Promise<DrainFenceKey|null>;readRestart():Promise<DrainFenceKey|null>;
 publishIdentity(marker:RuntimeMarker):Promise<void>;publishAck(key:DrainFenceKey):Promise<void>;removeIdentityIfOwned(marker:RuntimeMarker):Promise<void>;removeAckIfOwned(key:DrainFenceKey):Promise<void>;stopRequested():Promise<boolean>;
}
/** POSIX implementation only. Windows requires the matching write-through
 * replacement adapter; plain Node rename is not asserted equivalent to Rust's
 * MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH contract.
 * Caller must own the runtime instance. Read-then-remove matches source, but is
 * not an atomic compare/unlink against an independently writing foreign process. */
export class PosixDrainMarkerStore implements DrainMarkerStore{
 readonly #root:string;
 constructor(root:string){requireDiscordText(root);if(process.platform==='win32')throw new Error('Windows drain marker write-through adapter is not implemented');this.#root=root;}
 #path(kind:keyof typeof DRAIN_MARKER_NAMES):string{return this.#root===''?DRAIN_MARKER_NAMES[kind]:this.#root+(this.#root.endsWith('/')?'':'/')+DRAIN_MARKER_NAMES[kind];}
 async #exists(kind:keyof typeof DRAIN_MARKER_NAMES,fileOnly=false):Promise<boolean>{try{const value=await stat(this.#path(kind));return fileOnly?value.isFile():true;}catch{return false;}}
 prepareExists(){return this.#exists('prepare');}ackExists(){return this.#exists('ack');}stopRequested(){return this.#exists('stop',true);}
 async shutdownRequested():Promise<boolean>{return await this.stopRequested()||await this.#exists('restart',true);}
 async restartRequested():Promise<boolean>{return !await this.stopRequested()&&await this.#exists('restart',true);}
 async #read(kind:keyof typeof DRAIN_MARKER_NAMES):Promise<string|null>{
  const path=this.#path(kind);let handle;try{handle=await open(path,'r');}catch(error){if(code(error)==='ENOENT')return null;throw new DrainMarkerError('Io',path,null,error);}
  let primary:unknown;let failed=false;let result:string|null=null;
  try{const bytes=Buffer.alloc(4097);let used=0;while(used<bytes.length){const read=await handle.read(bytes,used,bytes.length-used,null);if(read.bytesRead===0)break;used+=read.bytesRead;}if(used>4096)throw malformed(path,'marker exceeds 4096 bytes');result=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,used));}catch(error){failed=true;primary=error instanceof DrainMarkerError?error:new DrainMarkerError('Io',path,null,error);}
  try{await handle.close();}catch(error){if(!failed){failed=true;primary=new DrainMarkerError('Io',path,null,error);}}if(failed)throw primary;return result;
 }
 async readIdentity(){const text=await this.#read('identity');return text===null?null:parseRuntimeIdentityMarker(text,this.#path('identity'));}
 async readPrepare(){const text=await this.#read('prepare');return text===null?null:parseRuntimeFenceMarker(text,this.#path('prepare'));}
 async readAck(){const text=await this.#read('ack');return text===null?null:parseRuntimeFenceMarker(text,this.#path('ack'),'sealed');}
 async readRestart(){const text=await this.#read('restart');return text===null?null:parseRuntimeFenceMarker(text,this.#path('restart'));}
 async #write(kind:'identity'|'ack',text:string):Promise<void>{
  const path=this.#path(kind),parent=dirname(path);let temporary:string|null=null;let temporaryOwned=false;
  try{await mkdir(parent,{recursive:true});temporary=joinRuntimePath(parent,`.cdr-drain-${randomUUID()}.tmp`,'posix');const handle=await open(temporary,'wx',0o600);temporaryOwned=true;let failed=false,primary:unknown;try{await handle.writeFile(text,'utf8');await handle.sync();}catch(error){failed=true;primary=error;}try{await handle.close();}catch(error){if(!failed){failed=true;primary=error;}}if(failed)throw primary;await rename(temporary,path);temporary=null;}catch(error){if(temporary!==null&&temporaryOwned)try{await unlink(temporary);}catch{/* preserve the write failure */}throw new DrainMarkerError('Io',path,null,error);}
 }
 async publishIdentity(marker:RuntimeMarker){await this.#write('identity',encodeRuntimeIdentityMarker(marker));}
 async publishAck(key:DrainFenceKey){await this.#write('ack',encodeRuntimeAckMarker(key));}
 async #remove(kind:'identity'|'ack'){const path=this.#path(kind);try{await unlink(path);}catch(error){if(code(error)!=='ENOENT')throw new DrainMarkerError('Io',path,null,error);}}
 async removeIdentityIfOwned(marker:RuntimeMarker){const expected=identity(marker),current=await this.readIdentity();if(current!==null&&current.runtimeId===expected.runtimeId&&current.processId===expected.processId)await this.#remove('identity');}
 async removeAckIfOwned(key:DrainFenceKey){if(getDrainFenceKeyRecord(key)===null)throw new DrainGateError('InvalidKey');const current=await this.readAck();if(current!==null&&DrainFenceKey.prototype.equals.call(key,current))await this.#remove('ack');}
}
