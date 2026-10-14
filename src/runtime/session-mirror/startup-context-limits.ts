import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotMirrorCursorAnchor,type MirrorCursorAnchor,type MirrorFileStamp} from '../../core/mirror-cursor-anchor.ts';

export interface MirrorStartupContextLimits {
 readonly maxBytes:number;readonly maxRecords:number;readonly maxRecordBytes:number;
 readonly maxWindowBytes:number;readonly maxTurnBytes:number;readonly timeoutMs:number;
}
export type MirrorStartupContextHold='IncompleteBoundary'|'ByteBudget'|'RecordBudget'|'RecordBytes'|'TurnBudget'|'InvalidUtf8'|'ChangedFile'|'Deadline'|'Cancelled'|'NativeRead';
export const MIRROR_STARTUP_CONTEXT_HOLDS:readonly MirrorStartupContextHold[]=Object.freeze(['IncompleteBoundary','ByteBudget','RecordBudget','RecordBytes','TurnBudget','InvalidUtf8','ChangedFile','Deadline','Cancelled','NativeRead']);
/** A held reconstruction is never a successful empty context. Keep its original
 * cutoff for any retry; this error does not authorize recapturing a later EOF. */
export class MirrorStartupContextHeldError extends Error {
 readonly reason:MirrorStartupContextHold;
 constructor(reason:MirrorStartupContextHold,cause?:unknown){super('Mirror startup context held: '+reason,{cause});this.name='MirrorStartupContextHeldError';this.reason=reason;}
}
export function snapshotMirrorStartupContextLimits(input:MirrorStartupContextLimits):MirrorStartupContextLimits {
 const maxBytes=own(input,'maxBytes'),maxRecords=own(input,'maxRecords'),maxRecordBytes=own(input,'maxRecordBytes'),maxWindowBytes=own(input,'maxWindowBytes'),maxTurnBytes=own(input,'maxTurnBytes'),timeoutMs=own(input,'timeoutMs');
 for(const [value,max] of [[maxBytes,67108864],[maxRecords,1048576],[maxRecordBytes,262144],[maxWindowBytes,1048576],[maxTurnBytes,16384],[timeoutMs,10000]] as const)if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>max)throw new RangeError('Invalid bounded mirror startup context limits');
 return Object.freeze({maxBytes,maxRecords,maxRecordBytes,maxWindowBytes,maxTurnBytes,timeoutMs}) as MirrorStartupContextLimits;
}
const stampKeys=['dev','ino','birthtimeNs','mtimeNs','ctimeNs','size'] as const;
export const sameMirrorStartupStamp=(a:MirrorFileStamp,b:MirrorFileStamp):boolean=>stampKeys.every(key=>a[key]===b[key]);
/** Structured-clone protocol data only. This shape does not authenticate a
 * cutoff; the reader accepts the privately branded native capture instead. */
export interface MirrorStartupCutoffData {readonly path:string;readonly offset:bigint;readonly stamp:MirrorFileStamp;readonly anchor:MirrorCursorAnchor|null;}
export function snapshotMirrorStartupCutoffData(input:unknown):MirrorStartupCutoffData {
 const path=own(input,'path'),offset=own(input,'offset'),rawStamp=own(input,'stamp'),rawAnchor=own(input,'anchor');
 if(typeof path!=='string'||path.length>32768)throw new TypeError('Invalid mirror startup cutoff');requireDiscordText(path);
 if(path.includes('\0')||Buffer.byteLength(path)>32768||typeof offset!=='bigint'||offset<0n||offset>=(1n<<63n))throw new TypeError('Invalid mirror startup cutoff');
 const stamp={} as Record<typeof stampKeys[number],bigint>;
 for(const key of stampKeys){const value=own(rawStamp,key);if(typeof value!=='bigint')throw new TypeError('Invalid mirror startup file stamp');stamp[key]=value;}
 for(const key of ['dev','ino','birthtimeNs','size'] as const)if(stamp[key]<0n||stamp[key]>=(1n<<64n))throw new TypeError('Invalid mirror startup file identity');
 for(const key of ['mtimeNs','ctimeNs'] as const)if(stamp[key]<-(1n<<63n)||stamp[key]>=(1n<<63n))throw new TypeError('Invalid mirror startup file timestamp');
 if(stamp.ino===0n||stamp.birthtimeNs===0n||stamp.size!==offset)throw new TypeError('Startup cutoff must be the captured exact EOF');
 const anchor=rawAnchor===null?null:snapshotMirrorCursorAnchor(rawAnchor as MirrorCursorAnchor);
 if(anchor===null?offset===0n:anchor.path!==path||anchor.offset!==offset||!sameMirrorStartupStamp(anchor.stamp,stamp))throw new TypeError('Invalid mirror startup boundary evidence');
 return Object.freeze({path,offset,stamp:Object.freeze(stamp),anchor});
}
