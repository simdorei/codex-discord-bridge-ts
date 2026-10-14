import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,lstatSync,openSync,closeSync,readSync,writeSync,fstatSync,fsyncSync} from 'node:fs';
import {basename,join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadArchivedRolloutIn,assertArchivedRolloutContained} from './preflight.ts';
import {planArchiveJsonScrub} from './metadata-plans.ts';
if(parentPort===null)throw new Error('Archive backup requires native worker ownership');
const input=workerData as {paths:{state:string;logs:string;global:string;bridge:string;index:string;rollout:string;root:string;archivedSessions?:string};id:string;cancelled:SharedArrayBuffer};
const cancelled=new Int32Array(input.cancelled),paths=input.paths;
let directory:string|null=null;
const check=()=>{if(Atomics.load(cancelled,0)!==0)throw new Error('Archive backup cancelled; retain partial recovery directory');};
const exists=(path:string)=>{try{return lstatSync(path);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
function regular(path:string,optional=false){const stat=exists(path);if(stat===null&&optional)return null;if(stat===null||!stat.isFile()||stat.isSymbolicLink())throw new Error('Archive source is not a regular file');return stat;}
function digest(fd:number):string{const hash=createHash('sha256'),buffer=Buffer.alloc(8192);let position=0;for(;;){check();const count=readSync(fd,buffer,0,buffer.length,position);if(count===0)break;hash.update(buffer.subarray(0,count));position+=count;}return hash.digest('hex');}
function copy(source:string,target:string,optional:boolean,maxBytes:number):boolean{
 if(regular(source,optional)===null)return false;
 const from=openSync(source,'r');let to:number|undefined;
 try{
  const before=fstatSync(from,{bigint:true});if(!before.isFile()||before.size>BigInt(maxBytes))throw new Error('Archive file exceeds bounded backup budget');
  to=openSync(target,'wx');const hash=createHash('sha256'),buffer=Buffer.alloc(8192);let position=0;
  for(;;){check();const n=readSync(from,buffer,0,buffer.length,position);if(n===0)break;if(position+n>maxBytes)throw new Error('Archive file grew past backup budget');let written=0;while(written<n)written+=writeSync(to,buffer,written,n-written);hash.update(buffer.subarray(0,n));position+=n;}
  fsyncSync(to);const after=fstatSync(from,{bigint:true}),named=lstatSync(source,{bigint:true});
  if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||named.isSymbolicLink()||named.dev!==after.dev||named.ino!==after.ino||digest(from)!==hash.digest('hex'))throw new Error('Archive source changed during backup');
  return true;
 }finally{try{if(to!==undefined)closeSync(to);}finally{closeSync(from);}}
}
async function snapshot(source:string,target:string,optional:boolean):Promise<boolean>{
 if(regular(source,optional)===null)return false;
 const db=new DatabaseSync(source,{readOnly:true});
 try{db.exec('PRAGMA busy_timeout=5000');const fd=openSync(target,'wx');const identity=fstatSync(fd,{bigint:true});closeSync(fd);check();await backup(db,target,{rate:100,progress(){check();}});check();const named=lstatSync(target,{bigint:true});if(!named.isFile()||named.dev!==identity.dev||named.ino!==identity.ino)throw new Error('Archive backup target changed');const saved=new DatabaseSync(target,{readOnly:true});try{if(saved.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw new Error('Archive backup integrity check failed');}finally{saved.close();}return true;}finally{db.close();}
}
function validateMetadata(path:string,bridge:boolean):void{
 if(regular(path,true)===null)return;const fd=openSync(path,'r');try{const bytes=Buffer.alloc(1048577);let length=0;for(;;){check();const n=readSync(fd,bytes,length,bytes.length-length,null);length+=n;if(length>1048576)throw new Error('Archive metadata exceeds bounded preflight budget');if(n===0)break;}planArchiveJsonScrub(bytes.subarray(0,length),input.id,bridge,1048576);}finally{closeSync(fd);}
}
let result:unknown;
try{
 check();if(paths.archivedSessions!==undefined){const db=new DatabaseSync(paths.state,{readOnly:true});try{paths.rollout=loadArchivedRolloutIn(db,input.id);}finally{db.close();}assertArchivedRolloutContained(paths.rollout,paths.archivedSessions);validateMetadata(paths.bridge,true);validateMetadata(paths.global,false);}
 const inputs=[paths.state,paths.logs,paths.global,paths.bridge,paths.index];const names=inputs.map(p=>basename(p));const folded=names.map(p=>p.toLowerCase());if(names.some(n=>n===''||n==='.'||n==='..')||new Set(folded).size!==5||folded.includes('transcript'))throw new Error('Archive backup input basenames collide');
 mkdirSync(paths.root,{recursive:true});const root=lstatSync(paths.root);if(!root.isDirectory()||root.isSymbolicLink())throw new Error('Archive backup root is not a regular directory');
 directory=join(paths.root,'delete-archive-'+randomUUID().replaceAll('-','')+'-'+[...input.id].filter(c=>/^[a-z0-9]$/i.test(c)).slice(0,8).join(''));mkdirSync(directory);
 let count=0;for(const [source,target,optional] of [[paths.state,names[0],false],[paths.logs,names[1],true]] as const){if(await snapshot(source,join(directory,target!),optional))count++;}
 for(const [source,target] of [[paths.global,names[2]],[paths.bridge,names[3]],[paths.index,names[4]]] as const){check();if(copy(source,join(directory,target!),true,1048576))count++;}
 const transcript=join(directory,'transcript');mkdirSync(transcript);if(copy(paths.rollout,join(transcript,'rollout.jsonl'),false,134217728))count++;check();result={ok:true,directory,files:count,rollout:paths.rollout};
}catch(e){result={ok:false,directory,message:e instanceof Error?e.message.slice(0,4096):'Archive backup failed'};}
parentPort.postMessage(result);parentPort.close();
