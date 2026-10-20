import {stat} from 'node:fs/promises';

/** Accept only the ordinary/extended Windows spelling of the same native file.
 * Keep the persisted spelling, cursor and generation; never retarget a cursor.
 * Dot segments, DOS names, trailing-dot/space and device/UNC aliases remain held. */
export async function sameMirrorRolloutPath(left:string,right:string,signal?:AbortSignal):Promise<boolean>{
 signal?.throwIfAborted();if(left===right)return true;
 if(process.platform!=='win32')return false;
 const extended=left.startsWith('\\\\?\\')?left:right.startsWith('\\\\?\\')?right:null;
 if(extended===null)return false;const ordinary=extended===left?right:left;
 if(!/^[A-Za-z]:\\/.test(ordinary)||extended!=='\\\\?\\'+ordinary)return false;
 const parts=ordinary.slice(3).split('\\');
 if(parts.some(p=>p===''||/[ .]$|[/:*?"<>|]/.test(p)||/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(p)))return false;
 let matches=false;
 try{
  const [a,b]=await Promise.all([stat(left,{bigint:true}),stat(right,{bigint:true})]);
  matches=a.isFile()&&b.isFile()&&a.ino!==0n&&a.birthtimeNs!==0n&&a.dev===b.dev&&a.ino===b.ino&&a.birthtimeNs===b.birthtimeNs;
 }catch{/* Missing/inaccessible aliases do not establish a binding. */}
 signal?.throwIfAborted();return matches;
}
