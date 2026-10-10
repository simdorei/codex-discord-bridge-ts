import {createHash} from 'node:crypto';
import {opendirSync,lstatSync,statSync,realpathSync,openSync,readSync,closeSync,fstatSync,constants,type BigIntStats} from 'node:fs';
import {join,relative,isAbsolute,extname,sep} from 'node:path';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {serdeField,serdeObject} from '../app-server/value.ts';
import {REMOTE_PLUGIN_ID,CHROME_PLUGIN_ID,ProPreflightError} from './preflight.ts';
import {parseExpectedRemotePluginVersion} from './manifest.ts';
export type FingerprintFailure='Inventory'|'Content'|'Io';
export class PluginFingerprintError extends Error{readonly kind:FingerprintFailure;readonly detail:string;constructor(kind:FingerprintFailure,detail:string){super((kind==='Inventory'?'invalid plugin inventory: ':kind==='Content'?'plugin content could not be verified: ':'plugin content I/O error: ')+detail);this.name='PluginFingerprintError';this.kind=kind;this.detail=detail;}}
const message=(e:unknown)=>e instanceof Error?e.message:'native file failure';
function content(s:string):never{throw new PluginFingerprintError('Content',s);};
function inventory(s:string):never{throw new PluginFingerprintError('Inventory',s);};
const same=(a:BigIntStats,b:BigIntStats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
const u64=(n:bigint)=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(n);return b;};
function ignored(path:string):boolean{return path.split(sep).includes('__pycache__')||['.pyc','.pyo'].includes(extname(path).replace(/[A-Z]/g,c=>c.toLowerCase()));}
/** Blocking native implementation is invoked only inside the owned files worker.
 * Source-compatible 64-bit lengths and DFS filename ordering. Resource overruns,
 * Unicode-lossy names and observable concurrent mutation fail closed, not truncated. */
export function pluginTreeDigestBlocking(input:string):string{
 if(!['x64','arm64'].includes(process.arch))throw new TypeError('Expected supported 64-bit plugin fingerprint platform');
 if(process.platform==='win32')throw new TypeError('Windows reparse-point evidence requires its native implementation');
 try{
  const root=realpathSync(input),initial=statSync(root,{bigint:true});if(!initial.isDirectory())content('plugin source is not a directory');
  const digest=createHash('sha256'),deadline=performance.now()+10000;let entries=0,bytes=0n;
  const budget=()=>{if(performance.now()>deadline)content('plugin source observation exceeded 10 seconds');};
  const check=(path:string,rel:string)=>{const s=lstatSync(path,{bigint:true});if(s.isSymbolicLink())content(`plugin source contains a link: ${rel}`);const resolved=realpathSync(path),part=relative(root,resolved);if(part==='..'||part.startsWith('..'+sep)||isAbsolute(part))content(`plugin source escapes root: ${rel}`);return s;};
  const hashFile=(path:string,rel:string,before:BigIntStats)=>{
   bytes+=before.size;if(bytes>2147483648n)content('plugin source exceeds 2 GiB observation budget');
   const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   try{const opened=fstatSync(fd,{bigint:true});if(!opened.isFile()||!same(before,opened))content(`plugin file changed before read: ${rel}`);
    const name=Buffer.from(rel.replaceAll('\\','/'));digest.update(u64(BigInt(name.length))).update(name).update(u64(opened.size));
    const buffer=Buffer.alloc(1048576);let total=0n;for(;;){budget();const n=readSync(fd,buffer,0,buffer.length,null);if(n===0)break;total+=BigInt(n);if(total>opened.size)content(`plugin file grew during read: ${rel}`);digest.update(buffer.subarray(0,n));}
    if(total!==opened.size||!same(opened,fstatSync(fd,{bigint:true}))||!same(opened,check(path,rel)))content(`plugin file changed during read: ${rel}`);
   }finally{closeSync(fd);}
  };
  const walk=(path:string,depth:number)=>{
   budget();if(depth>128)content('plugin source exceeds directory depth budget');
   const before=lstatSync(path,{bigint:true}),directory=opendirSync(path,{bufferSize:32}),names:string[]=[];
   try{for(;;){budget();const entry=directory.readSync();if(entry===null)break;if(++entries>100000||names.length===4096)content('plugin source exceeds directory entry budget');if(entry.name.includes('\ufffd'))content('plugin source contains an unverifiable Unicode filename');names.push(entry.name);}}finally{directory.closeSync();}
   names.sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
   for(const name of names){budget();const child=join(path,name),rel=relative(root,child),meta=lstatSync(child,{bigint:true});
    // WalkDir still traverses ignored real directories but never follows links.
    if(ignored(rel)){if(meta.isDirectory()&&!meta.isSymbolicLink())walk(child,depth+1);continue;}
    const checked=check(child,rel);if(checked.isDirectory())walk(child,depth+1);else if(checked.isFile())hashFile(child,rel,checked);
   }
   if(!same(before,lstatSync(path,{bigint:true})))content('plugin directory changed during observation');
  };
  walk(root,0);if(!same(initial,statSync(root,{bigint:true})))content('plugin root changed during observation');return digest.digest('hex');
 }catch(error){if(error instanceof PluginFingerprintError)throw error;throw new PluginFingerprintError('Io',message(error));}
}
export function fingerprintRequiredPluginsBlocking(raw:string):string{
 let value:unknown;try{value=parseSerdeValue(raw);}catch(error){inventory(message(error));}
 const records=serdeField(value,'installed');if(!serdeObject(value)||!Array.isArray(records))inventory('installed must be an array');
 const evidence=[REMOTE_PLUGIN_ID,CHROME_PLUGIN_ID].map(id=>{
  const matches=records.filter(record=>serdeObject(record)&&serdeField(record,'pluginId')===id);if(matches.length!==1)inventory(`plugin '${id}' was not installed exactly once`);const record=matches[0];
  if(serdeField(record,'installed')!==true||serdeField(record,'enabled')!==true)inventory(`plugin '${id}' is not installed and enabled`);
  const version=serdeField(record,'version');if(typeof version!=='string'||version==='')inventory(`plugin '${id}' version`);
  const source=serdeField(record,'source'),rawPath=serdeObject(source)?serdeField(source,'path'):undefined;if(typeof rawPath!=='string'||rawPath==='')inventory(`plugin '${id}' source.path`);
  let root:string;try{root=realpathSync(rawPath);}catch(error){content(`plugin '${id}' source unavailable: ${message(error)}`);}
  if(!statSync(root,{bigint:true}).isDirectory())content(`plugin '${id}' source is not a directory`);
  const tree=pluginTreeDigestBlocking(root);
  // serde_json struct serialization preserves declaration order, unlike Value maps.
  return '{"plugin_id":'+serializeSerdeValue(id)+',"version":'+serializeSerdeValue(version)+',"source_path":'+serializeSerdeValue(root)+',"tree_sha256":'+serializeSerdeValue(tree)+'}';
 });
 return createHash('sha256').update('['+evidence.join(',')+']','utf8').digest('hex');
}
export function readExpectedRemoteVersionBlocking(path:string):string{
 let text:string;
 try{const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=fstatSync(fd,{bigint:true});if(!before.isFile()||before.size>1048576n)throw new Error('manifest must be a regular file no larger than 1 MiB');const bytes=Buffer.alloc(Number(before.size)+1);let used=0;while(used<bytes.length){const n=readSync(fd,bytes,used,bytes.length-used,null);if(n===0)break;used+=n;}if(BigInt(used)!==before.size||!same(before,fstatSync(fd,{bigint:true})))throw new Error('manifest changed during read');text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,used));}finally{closeSync(fd);}}
 catch(error){throw new ProPreflightError('PluginManifest','RemoteManifestUnavailable','The remote plugin manifest could not be read.','Reinstall the remote plugin, then retry !pro.',`remote plugin manifest is unavailable: ${message(error)}`,error);}
 return parseExpectedRemotePluginVersion(text);
}
