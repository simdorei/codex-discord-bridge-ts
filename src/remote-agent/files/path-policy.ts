import {requireDiscordText} from '../../discord/text.ts';
export type RemotePathPlatform='posix'|'win32';
import {RemoteFileFailure} from './error.ts';
export class RemoteFilePolicyError extends RemoteFileFailure{
 constructor(kind:'UnsafePath'|'UnsafePattern'|'Limit',value:string,reason:string){super(kind,value,reason);this.name='RemoteFilePolicyError';}
}
const sensitive=new Set(['.aws','.codex-remote-mcp','.env','.git','.npmrc','.ssh','cookies.txt','credentials','id_ed25519','id_rsa','secrets','gcloud']);
function platform(p:RemotePathPlatform):void{if(p!=='posix'&&p!=='win32')throw new TypeError('Expected remote path platform');}
function bounded(value:string):void{requireDiscordText(value);if(value.length>32768||Buffer.byteLength(value)>32768)throw new RemoteFilePolicyError('Limit','path/pattern','input exceeds32768bytes');}
function components(value:string,p:RemotePathPlatform):string[]{return value.split(p==='win32'?/[\\/]/u:'/').filter(part=>part!==''&&part!=='.'&&part!=='..');}
/** Pure spelling policy only. A passing path grants no native filesystem access. */
export function remotePathIsSensitive(value:string,p:RemotePathPlatform):boolean{
 bounded(value);platform(p);const parts=components(value,p).map(s=>s.toLowerCase());if(parts.some(part=>sensitive.has(part)))return true;
 const name=parts.at(-1)??'';return name==='.env'||name.startsWith('.env.')||['.pem','.key','.p12','.pfx','.keystore'].some(s=>name.endsWith(s))||name.startsWith('id_rsa')||['token','secret','credential'].some(s=>name.includes(s));
}
export function validateRemoteRelativePath(value:string,p:RemotePathPlatform):string{
 bounded(value);platform(p);const parts=value.split(p==='win32'?/[\\/]/u:'/');
 if(value===''||value.includes('\0')||value.startsWith('/')||value.startsWith('\\')||Buffer.from(value)[1]===58||parts[0]==='.'||parts.includes('..')||value.split(/[\\/]/u).includes('..'))throw new RemoteFilePolicyError('UnsafePath',value,"relative paths without '..' are required");
 if(remotePathIsSensitive(value,p))throw new RemoteFilePolicyError('UnsafePath',value,'sensitive paths are not exposed');
 return value;
}
export function validateRemoteGlob(pattern:string):void{
 bounded(pattern);const parts=pattern.split('/');
 if(pattern===''||pattern.includes('\0')||pattern.includes('\\')||pattern.startsWith('/')||Buffer.from(pattern)[1]===58||parts.includes('..')||parts.filter(x=>x==='**').length>1)throw new RemoteFilePolicyError('UnsafePattern',pattern,"relative glob patterns without '..' segments are required");
 if(parts.length>4096)throw new RemoteFilePolicyError('Limit','pattern','glob exceeds4096segments');
}
/** Iterative UTF8-byte source grammar; explicit work limits refuse the whole
 * match rather than returning a partial selection. Native Windows unqualified. */
export function remoteGlobMatches(pattern:string,value:string,p:RemotePathPlatform):boolean{
 validateRemoteGlob(pattern);bounded(value);platform(p);const patterns=pattern.split('/'),values=value.split('/');if(values.length>4096)throw new RemoteFilePolicyError('Limit','path','path exceeds4096segments');
 let work=0;const charge=(n:number)=>{work+=n;if(work>8000000)throw new RemoteFilePolicyError('Limit','pattern','glob exceeds8000000work cells');};
 const component=(a:string,b:string)=>{const left=Buffer.from(p==='win32'?a.toLowerCase():a),right=Buffer.from(p==='win32'?b.toLowerCase():b);charge((left.length+1)*(right.length+1));let state=new Uint8Array(right.length+1);state[0]=1;
  for(const token of left){const next=new Uint8Array(right.length+1);if(token===42){next[0]=state[0]!;for(let i=1;i<next.length;i++)next[i]=next[i-1]||state[i]!;}else for(let i=1;i<next.length;i++)next[i]=state[i-1]&&(token===63||token===right[i-1])?1:0;state=next;}return state[right.length]===1;
 };
 let state=new Uint8Array(values.length+1);state[0]=1;
 for(const part of patterns){charge(values.length+1);const next=new Uint8Array(values.length+1);if(part==='**'){next[0]=state[0]!;for(let i=1;i<next.length;i++)next[i]=state[i]||next[i-1]!;}else for(let i=1;i<next.length;i++)if(state[i-1])next[i]=component(part,values[i-1]!)?1:0;state=next;}
 return state[values.length]===1;
}

/** Display/protocol spelling only; never use to replace the validated native path. */
export function remoteRelativeText(value:string):string{bounded(value);return value.replaceAll('\\','/');}
