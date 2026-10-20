import {joinRuntimePath,type PathPlatform} from '../runtime/runtime-paths/path-text.ts';

const options:ReadonlyMap<string,readonly string[]>=new Map([
 ['setup-discord',['--bot-id','--dry-run','--input-stdin','--input-lines']],
 ['configure-install',['--codex-home','--codex-exe']],
 ['verify-plugin-inventory',['--marketplace-inventory','--plugin-inventory','--plugin-manifest','--marketplace-name','--plugin-id']],
 ['discover-codex',['--codex-exe']],['backup-store',[]],['active-queue-count',[]],['retire-automatic-reserve',[]],
 ['authorize-saved-final',['--request-file']],['list-threads',['--limit']],['archive-thread',['--thread-id']],
 ['inspect-new-first-reply',['--database','--job-id']],
 ['recover-writer',['--thread-id','--channel-id','--owner-user-id','--dry-run']],
 ['recover-tools',['--thread-id','--channel-id','--owner-user-id','--dry-run']],
 ['inspect-async-recovery',['--database','--thread-id','--dry-run']],
 ['migrate-mirror-cursors',['--thread-id']],
 ['check-recovery-compatibility',['--database','--env']],
 ['send-attachment',['--channel-id','--thread-ref','--work-thread','--content','--content-file']],
]);
function text(value:unknown):string{
 if(typeof value!=='string'||!(value as unknown as {isWellFormed():boolean}).isWellFormed())throw new Error('admin arguments must be UTF-8');
 return value;
}
/** Pure frozen Rust admin argument contract. Recognizing a command is not an
 * implementation or authorization of its effects. No environment or IO here. */
export class AdminArgs {
 readonly command:string;
 readonly dryRun:boolean;
 readonly inputStdin:boolean;
 readonly inputLines:boolean;
 readonly files:readonly string[];
 #values:ReadonlyMap<string,string>;
 private constructor(command:string,values:Map<string,string>,files:string[]){
  this.command=command;this.#values=new Map(values);this.files=Object.freeze([...files]);
  this.dryRun=values.has('--dry-run');this.inputStdin=values.has('--input-stdin');this.inputLines=values.has('--input-lines');Object.freeze(this);
 }
 static parse(arguments_:readonly string[]):AdminArgs{
  if(arguments_.length===0)throw new Error('missing admin command');
  const command=text(arguments_[0]),allowed=options.get(command);
  if(allowed===undefined)throw new Error(`unknown admin command: ${command}`);
  const values=new Map<string,string>(),files:string[]=[];
  for(let i=1;i<arguments_.length;i++){
   const key=text(arguments_[i]);
   if(command==='send-attachment'){
    if(key==='--'){for(i++;i<arguments_.length;i++)files.push(text(arguments_[i]));break;}
    if(!key.startsWith('-')){files.push(key);continue;}
   }
   if(key!=='--repo-root'&&!allowed.includes(key))throw new Error(`unknown option for ${command}: ${key}`);
   if(values.has(key))throw new Error(`duplicate admin option: ${key}`);
   if(key==='--dry-run'||key==='--input-stdin'||key==='--input-lines')values.set(key,'');
   else{if(++i>=arguments_.length)throw new Error(`missing value after ${key}`);values.set(key,text(arguments_[i]));}
  }
  if(Number(values.has('--dry-run'))+Number(values.has('--input-stdin'))+Number(values.has('--input-lines'))>1)throw new Error('--dry-run, --input-stdin and --input-lines cannot be combined');
  return new AdminArgs(command,values,files);
 }
 value(name:string):string|undefined{return this.#values.get(name);}
 required(name:string):string{const value=this.value(name);if(value===undefined||value==='')throw new Error(`missing required option ${name}`);return value;}
 /** Caller captures actual cwd; preserve native traversal, including symlink/.. . */
 root(current:string,platform:PathPlatform):string{const root=this.value('--repo-root');return root===undefined?current:joinRuntimePath(current,root,platform);}
}
