import {parentPort,workerData} from 'node:worker_threads';import {DatabaseSync,backup} from 'node:sqlite';import {statSync,lstatSync,mkdirSync,openSync,fstatSync,closeSync,unlinkSync} from 'node:fs';import {joinRuntimePath} from '../runtime/runtime-paths/path-text.ts';
import {assertStoreIntegrity,schemaVersion,UnsupportedVersionError} from './schema-assembly.ts';
if(parentPort===null)throw new Error('Cutover backup requires an owned native worker');
const {attempt}=workerData as {attempt:{source:string;directory:string;stem:string;suffix:string}},cancelled=new Int32Array(workerData.cancelled as SharedArrayBuffer);
let source:DatabaseSync|undefined,target:string|null=null,identity:{dev:bigint;ino:bigint}|undefined;
const check=()=>{if(Atomics.load(cancelled,0)!==0)throw new Error('Cutover backup cancellation requested');};
const current=()=>{if(target===null||identity===undefined)return false;const s=lstatSync(target,{bigint:true});return s.isFile()&&!s.isSymbolicLink()&&s.dev===identity.dev&&s.ino===identity.ino;};
let result:unknown;
try{
 check();if(!statSync(attempt.source).isFile())throw new Error('Store database was not found or is not a regular file');source=new DatabaseSync(attempt.source,{readOnly:true});source.exec('PRAGMA busy_timeout=5000');assertStoreIntegrity(source);const version=schemaVersion(source);check();
 mkdirSync(attempt.directory,{recursive:true});if(!lstatSync(attempt.directory).isDirectory()||lstatSync(attempt.directory).isSymbolicLink())throw new Error('Backup directory is not an owned regular directory');
 target=joinRuntimePath(attempt.directory,`${attempt.stem}.v${version}-cutover.${attempt.suffix}.sqlite`,'posix');const fd=openSync(target,'wx');try{const s=fstatSync(fd,{bigint:true});identity={dev:s.dev,ino:s.ino};}finally{closeSync(fd);}
 try{check();await backup(source,target,{rate:100,progress(){check();}});check();if(!current())throw new Error('Backup target identity changed');const copied=new DatabaseSync(target,{readOnly:true});try{assertStoreIntegrity(copied);const actual=schemaVersion(copied);if(actual!==version)throw new UnsupportedVersionError(actual,version);}finally{copied.close();}if(!current())throw new Error('Backup target identity changed after validation');result={ok:true,path:target};}
 catch(primary){try{if(current())unlinkSync(target);else throw new Error('Incomplete backup identity changed; target retained');}catch(cleanup){throw new AggregateError([cleanup,primary],'Incomplete backup cleanup failed');}throw primary;}
}catch(error){let message=error instanceof Error?error.message:'Cutover backup failed';if(error instanceof AggregateError)message+=': '+error.errors.map(e=>e instanceof Error?e.message:'unknown error').join('; ');result={ok:false,name:error instanceof Error?error.name.slice(0,100):'UnknownError',message:message.slice(0,4096),target};}
finally{try{source?.close();}catch(error){result={ok:false,name:'SourceCloseError',message:error instanceof Error?error.message.slice(0,4096):'Source close failed',target};}parentPort.postMessage(result);parentPort.close();}
