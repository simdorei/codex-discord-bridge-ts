import {requireDiscordText} from '../../discord/text.ts';
export type PathPlatform='win32'|'posix';
interface Prefix{length:number;drive:boolean;verbatim:boolean}
const separator=(s:string|undefined)=>s==='/'||s==='\\';
function prefix(path:string):Prefix|null{
 const head=path.slice(0,8).replaceAll('/','\\');
 const component=(start:number,verbatim:boolean):[number,number]=>{let end=start;while(end<path.length&&!(verbatim?path[end]==='\\':separator(path[end])))end++;return [end,end<path.length?end+1:end];};
 if(head.startsWith('\\\\')){
  if(path.startsWith('\\\\?\\')){
   if(head.startsWith('\\\\?\\UNC\\')){const [serverEnd,shareStart]=component(8,true),[shareEnd]=component(shareStart,true);return {length:8+(serverEnd-8)+(shareEnd>shareStart?1+shareEnd-shareStart:0),drive:false,verbatim:true};}
   const tail=path.slice(4);if(/^[a-z]:/i.test(tail)&&(tail.length===2||separator(tail[2])))return {length:6,drive:false,verbatim:true};
   return {length:component(4,true)[0],drive:false,verbatim:true};
  }
  if(head.startsWith('\\\\.\\'))return {length:component(4,false)[0],drive:false,verbatim:false};
  const [serverEnd,shareStart]=component(2,false),[shareEnd]=component(shareStart,false);
  return serverEnd>2&&shareEnd>shareStart?{length:shareEnd,drive:false,verbatim:false}:null;
 }
 return /^[a-z]:/i.test(path)?{length:2,drive:true,verbatim:false}:null;
}
type Component={kind:'prefix'|'root'|'normal'|'current'|'parent';text:string};
function components(path:string,p:Prefix|null):Component[]{
 const out:Component[]=[];let tail=path;if(p){out.push({kind:'prefix',text:path.slice(0,p.length)});tail=path.slice(p.length);}
 const physical=separator(tail[0]);if(physical){out.push({kind:'root',text:'\\'});tail=tail.slice(1);}else if(p&&!p.drive&&!p.verbatim)out.push({kind:'root',text:'\\'});
 const parts=tail.split(p?.verbatim?'\\':/[\\/]/);
 for(let i=0;i<parts.length;i++){const text=parts[i]!;if(text==='')continue;if(text==='.'&&!p?.verbatim){if(i===0&&!p&&!physical)out.push({kind:'current',text});continue;}out.push({kind:text==='.'?'current':text==='..'?'parent':'normal',text});}return out;
}
/** Rust PathBuf push semantics for well-formed Unicode paths, without resolving
 * symlinks or normalizing ordinary '..'. Verbatim Windows paths follow Rust's
 * special append normalization. Native Windows filesystem qualification pending.
 * Reference: https://doc.rust-lang.org/std/path/struct.PathBuf.html#method.push */
export function joinRuntimePath(base:string,child:string,platform:PathPlatform):string{
 requireDiscordText(base);requireDiscordText(child);if(platform!=='win32'&&platform!=='posix')throw new TypeError('Expected path platform');
 if(platform==='posix')return child.startsWith('/')?child:base+(base!==''&&!base.endsWith('/')?'/':'')+child;
 const a=prefix(base),b=prefix(child);if(b)return child;
 if(a?.verbatim&&child!==''){
  const stack=components(base,a);
  for(const c of components(child,b)){if(c.kind==='root'){stack.length=1;stack.push(c);}else if(c.kind==='current')continue;else if(c.kind==='parent'){if(stack.at(-1)?.kind==='normal')stack.pop();}else stack.push(c);}
  let result='',sep=false;for(const c of stack){if(sep&&c.kind!=='root')result+='\\';result+=c.text;sep=c.kind==='root'?false:c.kind==='prefix'?!a.drive:true;}return result;
 }
 if(separator(child[0]))return base.slice(0,a?.length??0)+child;
 const sep=base!==''&&!separator(base.at(-1))&&!(a?.drive&&a.length===base.length);
 return base+(sep?'\\':'')+child;
}
