import {randomBytes} from 'node:crypto';
import {readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {RemoteFileMutations,fileDigest} from './files/mutations.ts';
import {RemoteFileFailure} from './files/error.ts';
import {WindowsFilePin} from '../runtime/windows/windows-file-pin.ts';
export interface FileMutation{readonly path:string;readonly content:Buffer|null;readonly expected:string|null;}
interface Snapshot{path:string;before_exists:boolean;before_base64:string;after_exists:boolean;after_base64:string;}
interface Checkpoint{checkpoint_id:string;created_at:string;reason:string;snapshots:Snapshot[];state?:'pending'|'complete'|'rolled_back';}
const conflict=(path:string)=>new RemoteFileFailure('Conflict',path,'file changed outside the checkpoint transaction');
const privatePath=(id:string)=>{if(!/^cp_[a-f0-9]{16}$/.test(id))throw new TypeError('Invalid checkpoint identity');return '.codex-remote-mcp/checkpoints/'+id+'.json';};
const entry=(r:Checkpoint)=>Object.freeze({checkpoint_id:r.checkpoint_id,created_at:r.created_at,reason:r.state==='pending'?'[pending] '+r.reason:r.state==='rolled_back'?'[rolled back] '+r.reason:r.reason});
export class NativeCheckpoints{
 #busy=false;
 constructor(readonly files:RemoteFileMutations){}
 async #capacity(incoming:number):Promise<void>{
  const directory=join(this.files.root,'.codex-remote-mcp','checkpoints');let names:string[];try{names=await readdir(directory);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}
  if(names.length>10000)throw new RangeError('Checkpoint scan exceeds budget');const records:{name:string;size:number;time:number}[]=[];let total=incoming;
  for(const name of names.filter(n=>/^cp_[a-f0-9]{16}\.json$/.test(n))){const s=await lstat(join(directory,name));if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)throw new Error('Unsafe checkpoint entry');records.push({name,size:s.size,time:s.mtimeMs});total+=s.size;}
  let count=records.length+1;for(const record of records.sort((a,b)=>a.time-b.time)){
   if(count<=500&&total<=536870912)return;const id=record.name.slice(0,-5),value=await this.#load(id);if(value.state==='pending')continue;
   const path=privatePath(id),raw=await this.files.read(path,33554432,true);if(raw===null)throw new Error('Checkpoint changed during retention');const current=JSON.parse(raw.toString('utf8')) as Checkpoint;if(current.state==='pending'||current.checkpoint_id!==id)throw new Error('Checkpoint changed during retention');await this.files.delete(path,fileDigest(raw),true);total-=record.size;count--;
  }
  if(count>500||total>536870912)throw new RangeError('Pending checkpoint recovery evidence fills retention budget');
 }
 async #load(id:string):Promise<Checkpoint>{const bytes=await this.files.read(privatePath(id),33554432,true);if(bytes===null)throw new Error('Checkpoint is unavailable');const r=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Checkpoint;
  if(r.checkpoint_id!==id||typeof r.created_at!=='string'||typeof r.reason!=='string'||!Array.isArray(r.snapshots)||r.snapshots.length>400||r.state!==undefined&&!['pending','complete','rolled_back'].includes(r.state))throw new TypeError('Malformed checkpoint');
  let size=0;for(const s of r.snapshots){this.files.path(s.path);for(const key of ['before_base64','after_base64']as const){if(typeof s[key]!=='string'||Buffer.from(s[key],'base64').toString('base64')!==s[key])throw new TypeError('Malformed checkpoint bytes');size+=Buffer.byteLength(s[key]);}if(typeof s.before_exists!=='boolean'||typeof s.after_exists!=='boolean')throw new TypeError('Malformed checkpoint existence');}if(size>30000000)throw new RangeError('Checkpoint exceeds budget');return r;
 }
 async mutate(reason:string,changes:readonly FileMutation[],signal?:AbortSignal):Promise<string>{
  if(this.#busy)throw new Error('Project checkpoint mutation already active');this.#busy=true;
  try{return await this.#mutate(reason,changes,signal);}finally{this.#busy=false;}
 }
 async #mutate(reason:string,changes:readonly FileMutation[],signal?:AbortSignal):Promise<string>{
  signal?.throwIfAborted();const seen=new Set<string>(),snapshots:Snapshot[]=[];let total=0;
  for(const change of changes){const key=process.platform==='win32'?change.path.toLowerCase():change.path;if(seen.has(key))throw new TypeError('Duplicate mutation path');seen.add(key);
   const before=await this.files.read(change.path,10485760);if(before===null?change.expected!==null:change.expected===null||fileDigest(before)!==change.expected)throw conflict(change.path);
   total+=(before?.length??0)+(change.content?.length??0);if(total>20971520)throw new RangeError('Checkpoint data exceeds 20 MiB');snapshots.push({path:change.path,before_exists:before!==null,before_base64:before?.toString('base64')??'',after_exists:change.content!==null,after_base64:change.content?.toString('base64')??''});
  }
  const record:Checkpoint={checkpoint_id:'cp_'+randomBytes(8).toString('hex'),created_at:new Date().toISOString(),reason,snapshots,state:'pending'},path=privatePath(record.checkpoint_id),pending=Buffer.from(JSON.stringify(record));
  // Durable undo evidence precedes every effect. Pending records are preserved
  // across crash and never replayed automatically.
  await this.#capacity(pending.length);
  await this.files.write(path,pending,null,true);const applied:FileMutation[]=[];
  try{
   for(const change of changes){signal?.throwIfAborted();if(change.content===null){if(change.expected!==null)await this.files.delete(change.path,change.expected);}else await this.files.write(change.path,change.content,change.expected);applied.push(change);}
   record.state='complete';await this.files.write(path,Buffer.from(JSON.stringify(record)),fileDigest(pending),true);return record.checkpoint_id;
  }catch(primary){
   try{for(const change of [...applied].reverse()){const snapshot=snapshots.find(s=>s.path===change.path)!;const current=await this.files.read(change.path,10485760);if(change.content===null?current!==null:current===null||fileDigest(current)!==fileDigest(change.content))throw conflict(change.path);if(snapshot.before_exists)await this.files.write(change.path,Buffer.from(snapshot.before_base64,'base64'),current===null?null:fileDigest(current));else if(current!==null)await this.files.delete(change.path,fileDigest(current));}}
   catch(cleanup){throw new AggregateError([primary,cleanup],'Checkpoint rollback is incomplete; retained pending evidence requires reconciliation');}
   try{record.state='rolled_back';await this.files.write(path,Buffer.from(JSON.stringify(record)),fileDigest(pending),true);}catch(cleanup){throw new AggregateError([primary,cleanup],'Checkpoint rollback status is unconfirmed; retained evidence requires reconciliation');}throw primary;
  }
 }
 async list(){const path=join(this.files.root,'.codex-remote-mcp','checkpoints');let pin:WindowsFilePin|undefined;try{
  try{if(process.platform==='win32')pin=WindowsFilePin.acquire(path,'directory');else if((await lstat(path)).isSymbolicLink())throw new Error('Checkpoint directory is a link');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'||(error as {win32Code?:number}).win32Code===2||(error as {win32Code?:number}).win32Code===3)return [];throw error;}
  const names=await readdir(path);if(names.length>10000)throw new RangeError('Checkpoint directory exceeds scan budget');const records=[];let total=0;
  for(const name of names.filter(n=>/^cp_[a-f0-9]{16}\.json$/.test(n))){total+=(await lstat(join(path,name))).size;if(total>536870912)throw new RangeError('Checkpoint scan exceeds byte budget');records.push(entry(await this.#load(name.slice(0,-5))));}
  return records.sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,50);
 }finally{pin?.close();}}
 async show(id:string){const record=await this.#load(id);let patch='';for(const s of record.snapshots){const before=Buffer.from(s.before_base64,'base64').toString('utf8'),after=Buffer.from(s.after_base64,'base64').toString('utf8');patch+=`--- a/${s.path}\n+++ b/${s.path}\n`+before.split('\n').map(l=>'-'+l).join('\n')+'\n'+after.split('\n').map(l=>'+'+l).join('\n')+'\n';if(Buffer.byteLength(patch)>1048576){patch=Buffer.from(patch).subarray(0,1048576).toString('utf8');break;}}
  return {checkpoint:entry(record),patch};}
 async restore(id:string,signal?:AbortSignal){const record=await this.#load(id),changes:FileMutation[]=[];
  for(const s of record.snapshots){const current=await this.files.read(s.path,10485760),after=s.after_exists?Buffer.from(s.after_base64,'base64'):null,before=s.before_exists?Buffer.from(s.before_base64,'base64'):null;
   const matches=(expected:Buffer|null)=>expected===null?current===null:current!==null&&fileDigest(expected)===fileDigest(current);
   if((record.state==='pending'||record.state==='rolled_back')&&matches(before))continue;if(record.state==='rolled_back'||!matches(after))throw conflict(s.path);changes.push({path:s.path,content:before,expected:current===null?null:fileDigest(current)});
  }
  if(changes.length)await this.mutate('restore '+id,changes,signal);return changes.map(c=>c.path);
 }
}
