import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {MirrorFileWindow,MirrorFileChangedError} from '../runtime/session-mirror/file-window.ts';
import type {MirrorCursorAnchor} from '../core/mirror-cursor-anchor.ts';
export const LEGACY_LINE_BYTES=8*1024*1024;
export class MigrationBudget {
 readonly deadline:number;
 constructor(milliseconds=25000,readonly signal?:AbortSignal){this.deadline=performance.now()+milliseconds;}
 check():void{this.signal?.throwIfAborted();if(performance.now()>=this.deadline)throw new Error('Mirror migration deadline exceeded');}
}
const stampKeys=['dev','ino','birthtimeNs','mtimeNs','ctimeNs','size'] as const;
/** Read only the already-consumed prefix. An absent turn is valid only after a
 * complete, bounded, strict-UTF-8 scan of the same observed generation. */
export async function recoverLegacyMirrorTurn(anchor:MirrorCursorAnchor,budget:MigrationBudget):Promise<string>{
 let offset=0n,parts:Uint8Array[]=[],lineBytes=0,turn='';
 const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
 const line=()=>{
  const text=decoder.decode(Buffer.concat(parts,lineBytes));parts=[];lineBytes=0;
  let prefix='',count=0;for(const char of text){if(count++===200)break;prefix+=char;}
  if(!prefix.includes('turn_context')&&!prefix.includes('task_started'))return;
  let event:any;try{event=parseSerdeValue(text);}catch{return;}
  const payload=event?.payload;
  if(payload!==null&&typeof payload==='object'&&!Array.isArray(payload)&&
    (event?.type==='turn_context'||payload.type==='task_started')&&typeof payload.turn_id==='string'&&payload.turn_id!=='')turn=payload.turn_id;
 };
 const append=(part:Uint8Array)=>{lineBytes+=part.length;if(lineBytes>LEGACY_LINE_BYTES)throw new Error('Legacy mirror line exceeds byte budget');parts.push(part);};
 while(offset<anchor.offset){
  budget.check();const remaining=anchor.offset-offset;
  const window=await MirrorFileWindow.read(anchor.path,offset,Number(remaining<65536n?remaining:65536n),budget.signal);budget.check();
  if(!stampKeys.every(key=>window.generation[key]===anchor.stamp[key]))throw new MirrorFileChangedError();
  const bytes=window.copyBytes();if(bytes.length===0)throw new MirrorFileChangedError();
  let start=0;for(let i=0;i<bytes.length;i++){if(bytes[i]!==10)continue;append(bytes.subarray(start,i));line();budget.check();start=i+1;}
  if(start<bytes.length)append(bytes.subarray(start));offset+=BigInt(bytes.length);
 }
 if(lineBytes!==0)throw new Error('Legacy mirror cursor is not a complete LF boundary');
 budget.check();return turn;
}
