import {stat} from 'node:fs/promises';
import {join} from 'node:path';
import {RemoteFileMutations,fileDigest} from './files/mutations.ts';
import {RemoteFileFailure} from './files/error.ts';
import {scanRemoteOwnedFiles,type RemoteNativeRead} from './files/read-owner.ts';
import {redactRemoteText} from './files/redaction.ts';
import {NativeCheckpoints,type FileMutation} from './native-checkpoints.ts';
import {findNativeExecutable} from './native-terminal.ts';
import {runOwnedCommand} from '../runtime/windows/owned-command.ts';
import {imageEntry,downloadRemoteImage} from './native-images.ts';
import type {CoreRequest} from './core-request.ts';
import type {RemoteCoreOutput} from './core-output.ts';
import type {RemoteOperationContext} from './dispatcher-ports.ts';
const lines=(text:string)=>text===''?[]:text.replace(/\n$/,'').split('\n').map(s=>s.replace(/\r$/,''));
const strict=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
const utf8cut=(text:string,max:number)=>new TextDecoder().decode(Buffer.from(text).subarray(0,max));
const conflict=(path:string)=>new RemoteFileFailure('Conflict',path,'file already exists or changed since it was read');
export function safeCommandEnvironment():Record<string,string>{const env:Record<string,string>={};for(const key of ['PATH','HOME','LANG','LC_ALL','TMPDIR','TMP','TEMP','SystemDrive','SystemRoot','ProgramData','COMSPEC','ComSpec','PATHEXT','LOCALAPPDATA','APPDATA','USERPROFILE','SSH_AUTH_SOCK','CODEX_HOME'])if(process.env[key]!==undefined)env[key]=process.env[key]!;return env;}
type Command={command_id:string;display:string;source:string;risk_tier:'read'|'verify'|'network'|'destructive';argv:string[];};
/** Native project operations use the same session budget and mutation cache in
 * the dispatcher. This class never retries a mutation or manufactures receipts. */
export class NativeRemoteCore{
 readonly checkpoints:NativeCheckpoints;
 constructor(readonly files:RemoteFileMutations,readonly reader:RemoteNativeRead,readonly codexExe:string){this.checkpoints=new NativeCheckpoints(files);}
 async commands():Promise<Command[]>{
  const out:Command[]=[],manifest=await this.files.read('package.json');if(manifest!==null){const parsed=JSON.parse(strict(manifest)) as {scripts?:unknown};if(parsed.scripts!==undefined&&parsed.scripts!==null&&(typeof parsed.scripts!=='object'||Array.isArray(parsed.scripts)))throw new TypeError('Invalid package scripts');
   for(const [name,script]of Object.entries(parsed.scripts??{})){if(typeof script!=='string'||!/^[A-Za-z0-9:_-]+$/.test(name))continue;const args=script.trim().split(/\s+/),safe=args.length>=2&&args[0]?.toLowerCase()==='node'&&args[1]==='--test'&&args.every(x=>/^[A-Za-z0-9_./:@=+-]+$/.test(x));
    out.push({command_id:'npm:'+name,display:script,source:'package.json',risk_tier:!safe||/\bsudo\b|\brm\s+-\w*[rf]\w*|\bgit\s+(clean|reset)\b|\b(deploy|publish|release|destroy)\b/i.test(script)?'destructive':/\b(curl|wget)\b|\b(npm|pnpm|yarn|bun)\s+(install|add|update)|\bgit\s+(pull|fetch|clone|push)\b/i.test(script)?'network':/^(test|tests|typecheck|type-check|lint|check|verify|build|compile)$/i.test(name)?'verify':'read',argv:safe?['node','--preserve-symlinks-main',...args.slice(1)]:[]});}
  }
  for(const [file,id,argv]of [['Cargo.toml','cargo:test',['cargo','test']],['Cargo.toml','cargo:clippy',['cargo','clippy']],['go.mod','go:test',['go','test','./...']],['pubspec.yaml','flutter:test',['flutter','test']]]as const)if(await this.files.read(file)!==null)out.push({command_id:id,display:argv.join(' '),source:file,risk_tier:'verify',argv:[...argv]});
  if(await this.files.read('pyproject.toml')!==null&&await stat(join(this.files.root,'tests')).then(s=>s.isDirectory(),()=>false)){const argv=await this.files.read('uv.lock')!==null?['uv','run','pytest']:process.platform==='win32'?['py','-3','-m','pytest']:['python3','-m','pytest'];out.push({command_id:'python:test',display:'pytest',source:'pyproject.toml',risk_tier:'verify',argv});}return out;
 }
 async #run(executable:string,args:readonly string[],context:RemoteOperationContext,cap=120000,maxBytes=400000,environment=safeCommandEnvironment()){
  context.signal.throwIfAborted();return runOwnedCommand({executable,arguments:args,cwd:this.files.root,environment,inheritEnvironment:false},{timeoutMs:Math.max(1,Math.min(cap,Number(context.budget.remaining()/1000000n))),maxBytes,signal:context.signal,truncate:true});
 }
 async git(args:readonly string[],context:RemoteOperationContext,allowFailure=false,allowTruncated=false,push=false){
  const nul=process.platform==='win32'?'NUL':'/dev/null',executable=await findNativeExecutable(['git']),environment={...safeCommandEnvironment(),GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:nul,GIT_LITERAL_PATHSPECS:'1'};
  const prefix=['-c','core.hooksPath='+nul,'-c','core.fsmonitor=false','-c','commit.gpgSign=false','-c','credential.helper=','-c','safe.directory='+this.files.root];
  if(push){const helpers=new Set<string>();for(const scope of ['--system','--global']){const r=await this.#run(executable,['config',scope,'--get-all','credential.helper'],context,10000,12000,{...safeCommandEnvironment(),GIT_TERMINAL_PROMPT:'0'});if(r.exitCode===0&&!r.truncated)for(const h of lines(r.stdout.toString()).map(x=>x.trim()))if(/^[A-Za-z0-9._/+:-]+(?:\s+--?[A-Za-z0-9._/=:+-]+)*$/.test(h))helpers.add(h);}for(const h of [...helpers].sort())prefix.push('-c','credential.helper='+h);}
  const r=await this.#run(executable,[...prefix,...args],context,push?300000:120000,400000,environment);
  if(r.truncated&&!allowTruncated)throw new RangeError('Git output exceeds capture budget');if(r.exitCode!==0&&!allowFailure)throw new Error('Git command failed: '+await redactRemoteText(utf8cut((r.stderr.length?r.stderr:r.stdout).toString('utf8'),4000)));
  return {stdout:r.stdout.toString('utf8'),stderr:r.stderr.toString('utf8'),success:r.exitCode===0,truncated:r.truncated};
 }
 async status(context:RemoteOperationContext):Promise<Extract<RemoteCoreOutput,{kind:'repo_status'}>>{
  const branch=(await this.git(['branch','--show-current'],context)).stdout.trim(),porcelain=(await this.git(['status','--porcelain=v1','-z'],context)).stdout.split('\0');const dirty_files:string[]=[],staged_files:string[]=[];
  for(let i=0;i<porcelain.length;i++){const row=porcelain[i]!;if(row.length<4)continue;const path=row.slice(3);dirty_files.push(path);if(row[0]!==' '&&row[0]!=='?')staged_files.push(path);if(row[0]==='R'||row[0]==='C'||row[1]==='R'||row[1]==='C')i++;}
  const remotes=lines((await this.git(['remote'],context)).stdout),tracking=await this.git(['rev-parse','--abbrev-ref','--symbolic-full-name','@{upstream}'],context,true);let ahead=0n,behind=0n;
  if(tracking.success){const counts=(await this.git(['rev-list','--left-right','--count','HEAD...@{upstream}'],context)).stdout.trim().split(/\s+/);ahead=BigInt(counts[0]??0);behind=BigInt(counts[1]??0);}
  return {kind:'repo_status',branch,dirty_files,staged_files,remotes,upstream:tracking.success?tracking.stdout.trim():null,ahead,behind};
 }
 async write(path:string,content:string,expected:string|null,signal?:AbortSignal){const bytes=Buffer.from(content);if(bytes.length>1048576)throw new RangeError('File exceeds 1 MiB');const checkpoint_id=await this.checkpoints.mutate('write file',[{path,content:bytes,expected}],signal);return {path,sha256:fileDigest(bytes),bytes_written:BigInt(bytes.length),created:expected===null,checkpoint_id};}
 async execute(request:CoreRequest,context:RemoteOperationContext):Promise<RemoteCoreOutput>{
  context.signal.throwIfAborted();context.budget.remaining();
  switch(request.kind){
   case 'project_rules':{const rules=[];for(const path of ['AGENTS.md','CLAUDE.md','.codex/config.toml']){context.signal.throwIfAborted();let bytes;try{bytes=await this.files.read(path);}catch(error){if(error instanceof RemoteFileFailure&&(error.kind==='Size'||error.kind==='UnsafePath'))continue;throw error;}if(bytes===null)continue;let content;try{content=strict(bytes);}catch{continue;}rules.push({path,content:await redactRemoteText(utf8cut(content,20000),context.signal)});}return {kind:'project_rules',rules};}
   case 'code_search':{const matches=[];for(const {path}of (await scanRemoteOwnedFiles(this.reader,context.signal)).files){context.signal.throwIfAborted();context.budget.remaining();if(matches.length>=Number(request.max_results))break;let content;try{const bytes=await this.files.read(path);if(bytes===null||bytes.includes(0))continue;content=strict(bytes);}catch{continue;}let number=0;for(const line of lines(content)){number++;if(line.includes(request.query))matches.push({path,line:BigInt(number),snippet:await redactRemoteText(utf8cut(line.trim(),400),context.signal)});if(matches.length>=Number(request.max_results))break;}}return {kind:'code_search',matches};}
   case 'command_list':return {kind:'command_list',commands:(await this.commands()).map(({argv,...descriptor})=>descriptor)};
   case 'command_run':{const selected=(await this.commands()).find(c=>c.command_id===request.command_id);if(!selected||['network','destructive'].includes(selected.risk_tier)||!selected.argv.length)throw new Error('Command is not remotely executable');const start=performance.now();
    const r=await this.#run(this.codexExe,['sandbox','-C',this.files.root,'-P',':workspace','--sandbox-state-disable-network','--',...selected.argv],context,Number(request.timeout_seconds)*1000,12000);
    return {kind:'command_run',command_id:request.command_id,exit_code:BigInt(r.exitCode??-1),stdout:await redactRemoteText(r.stdout.toString('utf8')),stderr:await redactRemoteText(r.stderr.toString('utf8')),duration_ms:BigInt(Math.round(performance.now()-start)),truncated:r.truncated};}
   case 'repo_status':return this.status(context);
   case 'project_status':{const status=await this.status(context),rules=await this.execute({kind:'project_rules'},context);return {kind:'project_status',branch:status.branch,dirty_files:status.dirty_files,staged_files:status.staged_files,rule_files:rules.kind==='project_rules'?rules.rules.map(r=>r.path):[],command_ids:(await this.commands()).map(c=>c.command_id)};}
   case 'repo_diff':{const nums=await this.git(['diff','--no-ext-diff','--no-textconv','--numstat','HEAD','--'],context),patch=await this.git(['diff','--no-ext-diff','--no-textconv','HEAD','--'],context,false,true);const files=lines(nums.stdout).map(row=>{const [a,r,...path]=row.split('\t');return {path:path.join('\t'),added:/^\d+$/.test(a??'')?BigInt(a!):0n,removed:/^\d+$/.test(r??'')?BigInt(r!):0n};});return {kind:'repo_diff',files,summary:`${files.length} changed files`,patch:await redactRemoteText(utf8cut(patch.stdout,200000)),truncated:patch.truncated||Buffer.byteLength(patch.stdout)>200000};}
   case 'git_commit':{for(const path of request.paths)this.files.path(path);const untracked=new Set((await this.git(['ls-files','--others','--exclude-standard','-z'],context)).stdout.split('\0')),newPaths=request.paths.filter(p=>untracked.has(p));if(newPaths.length)await this.git(['add','--intent-to-add','--',...newPaths],context);await this.git(['commit','--only','-m',request.message,'--',...request.paths],context);
    return {kind:'git_commit',commit:(await this.git(['rev-parse','--short','HEAD'],context)).stdout.trim(),branch:(await this.git(['branch','--show-current'],context)).stdout.trim(),staged_files:lines((await this.git(['diff-tree','--no-commit-id','--name-only','-r','HEAD'],context)).stdout)};}
   case 'git_push':{const remotes=lines((await this.git(['remote'],context)).stdout);if(!remotes.includes(request.remote))throw new Error('Git remote is not configured');const branch=request.branch??(await this.git(['branch','--show-current'],context)).stdout.trim();if(!branch)throw new Error('Detached HEAD requires an explicit branch');const r=await this.git(['push','-u','--',request.remote,branch],context,false,false,true);return {kind:'git_push',remote:request.remote,branch,output:await redactRemoteText(utf8cut((r.stdout+'\n'+r.stderr).trim(),200000))};}
   case 'file_create':{const before=await this.files.read(request.path);if(before!==null&&!request.overwrite)throw conflict(request.path);const r=await this.write(request.path,request.content,before===null?null:fileDigest(before),context.signal);return {kind:'file_create',path:r.path,sha256:r.sha256,bytes_written:r.bytes_written,checkpoint_id:r.checkpoint_id};}
   case 'file_apply_patch':{const changes:FileMutation[]=[],applied:Extract<RemoteCoreOutput,{kind:'file_apply_patch'}>['applied'][number][]=[];
    for(const c of request.changes){const before=await this.files.read(c.path);if(c.action==='create'?before!==null:before===null||fileDigest(before)!==c.expected_sha256)throw conflict(c.path);const original=before===null?'':strict(before),updated=c.action==='delete'?null:c.content??original;
     if(c.action==='move'){if(c.destination===null||await this.files.read(c.destination)!==null)throw conflict(c.destination??c.path);changes.push({path:c.destination,content:Buffer.from(updated!),expected:null},{path:c.path,content:null,expected:c.expected_sha256});}
     else changes.push({path:c.path,content:updated===null?null:Buffer.from(updated),expected:c.expected_sha256});
     const delta=lineDelta(original,updated??'');applied.push({path:c.path,action:c.action==='create'?'add':c.action,destination:c.destination,added_lines:BigInt(delta.added),removed_lines:BigInt(delta.removed)});
    }return {kind:'file_apply_patch',applied,checkpoint_id:await this.checkpoints.mutate('patch',changes,context.signal)};}
   case 'checkpoint_list':return {kind:'checkpoint_list',checkpoints:await this.checkpoints.list()};
   case 'checkpoint_show':{const r=await this.checkpoints.show(request.checkpoint_id);return {kind:'checkpoint_show',checkpoint:r.checkpoint,patch:await redactRemoteText(r.patch,context.signal)};}
   case 'checkpoint_restore':return {kind:'checkpoint_restore',checkpoint_id:request.checkpoint_id,restored_files:await this.checkpoints.restore(request.checkpoint_id,context.signal)};
   case 'save_image':case 'save_image_from_url':{let bytes:Buffer;if(request.kind==='save_image'){if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.data_base64))throw new TypeError('Invalid image base64');bytes=Buffer.from(request.data_base64,'base64');}else bytes=await downloadRemoteImage(request.url,context);const image=imageEntry(request.path,bytes),before=await this.files.read(request.path,5242880);if(before!==null&&!request.overwrite)throw conflict(request.path);await this.checkpoints.mutate('save image',[{path:request.path,content:bytes,expected:before===null?null:fileDigest(before)}],context.signal);return {kind:'image_save',image,sha256:fileDigest(bytes)};}
   case 'retrieve_image':{const bytes=await this.files.read(request.path,5242880);if(bytes===null)throw new Error('Image does not exist');return {kind:'image_retrieve',image:imageEntry(request.path,bytes),data_base64:bytes.toString('base64')};}
   case 'list_images':{const images=[];for(const {path}of (await scanRemoteOwnedFiles(this.reader,context.signal)).files){context.signal.throwIfAborted();if(!/\.(png|jpe?g|gif|webp)$/i.test(path))continue;try{const bytes=await this.files.read(path,5242880);if(bytes)images.push(imageEntry(path,bytes));}catch{}if(images.length>=200)break;}return {kind:'image_list',images};}
  }
 }
}
/** Exact LCS line counts with a finite work budget, rather than silently counting
 * every line as replaced. Large divergent inputs are refused before mutation. */
function lineDelta(before:string,after:string){const a=lines(before),b=lines(after);let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;let endA=a.length,endB=b.length;while(endA>start&&endB>start&&a[endA-1]===b[endB-1]){endA--;endB--;}
 const n=endA-start,m=endB-start;if(n*m>8000000)throw new RangeError('Patch diff exceeds computation budget');let prev=new Uint32Array(m+1);for(let i=0;i<n;i++){const row=new Uint32Array(m+1);for(let j=0;j<m;j++)row[j+1]=a[start+i]===b[start+j]?prev[j]!+1:Math.max(row[j]!,prev[j+1]!);prev=row;}return {added:m-prev[m]!,removed:n-prev[m]!};}
