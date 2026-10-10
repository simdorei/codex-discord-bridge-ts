import {types} from "node:util";
import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {receiptRow,receiptText,receiptTextColumns,receiptExists} from "./delivery-receipt-key.ts";
import {decodeI64,decodeTimestamp} from "./sqlite-values.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {COMPLETION_SOURCES,COMPLETION_PAGE_SIZE,MAX_COMPLETION_METADATA_BYTES,completionMetadataQuery,completionHeldMatch,completionSourceIsState,requireCompletionSource,type CompletionSource} from "./completion-metadata-sql.ts";
export interface CompletionPosition{readonly stamp:number;readonly ordinal:bigint;readonly id:string}
export interface CompletionEntry{readonly source:CompletionSource;readonly id:string;readonly target:string;readonly turn:string;readonly channel:bigint;readonly bytes:bigint;readonly position:CompletionPosition}
export interface CompletionCursor{readonly finished:boolean}
interface CursorData{after:CompletionPosition|null;upper:CompletionPosition|null;finished:boolean}
const cursors=new WeakMap<object,CursorData>();
function cursor(data:CursorData):CompletionCursor{const value=Object.freeze({finished:data.finished});cursors.set(value,data);return value;}
export function initialCompletionCursor():CompletionCursor{return cursor({after:null,upper:null,finished:false});}
function cursorData(value:CompletionCursor):CursorData{const data=value!==null&&typeof value==="object"?cursors.get(value):undefined;if(!data)throw new TypeError("Expected owned completion cursor");return {...data};}
export interface CompletionPage{readonly entries:readonly CompletionEntry[];readonly oversizedIdentity:boolean;readonly heldReceiptHeads:bigint}
export interface CompletionPageRead{readonly cursor:CompletionCursor;readonly page:CompletionPage}
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed metadata identity");}
function generation(value:unknown):asserts value is bigint{if(typeof value!=="bigint"||value<-(1n<<63n)||value>=(1n<<63n))throw new TypeError("Expected i64 metadata generation");}
const positionColumns=`stamp,ordinal,sort_id,${receiptTextColumns("sort_id")}`;
const entryColumns=`stamp,ordinal,sort_id,id,target,turn,channel,bytes,${receiptTextColumns("sort_id","id","target","turn")}`;
function readPosition(row:Record<string,unknown>):CompletionPosition{return Object.freeze({stamp:decodeTimestamp(row.stamp,"stamp"),ordinal:decodeI64(row.ordinal,"ordinal"),id:receiptText(row,"sort_id")!});}
function readEntry(source:CompletionSource,row:Record<string,unknown>):CompletionEntry{
  const position=readPosition(row),id=receiptText(row,"id")!,target=receiptText(row,"target")!,turn=receiptText(row,"turn")!,channel=decodeI64(row.channel,"channel"),bytes=decodeI64(row.bytes,"bytes");
  if(bytes<0n)throw new StoreIntegrityError("Negative completion payload length");
  return Object.freeze({source,id,target,turn,channel,bytes,position});
}
export function sameCompletionIdentity(a:CompletionEntry,b:CompletionEntry):boolean{return a.source===b.source&&a.id===b.id&&a.target===b.target&&a.turn===b.turn;}
/** One borrowed-snapshot page. Returns a new opaque cursor; input never mutates on failure.
 * Metadata hints do not authorize loading, execution or delivery. */
export function completionPageIn(db:DatabaseSync,source:CompletionSource,input:CompletionCursor,runtime:string,gen:bigint):CompletionPageRead{
  requireCompletionSource(source);text(runtime);generation(gen);const next=cursorData(input),query=completionMetadataQuery(source);
  if(next.upper===null){const row=receiptRow(db,`${query} SELECT ${positionColumns} FROM candidates ORDER BY stamp DESC,ordinal DESC,sort_id DESC LIMIT 1`,runtime,gen);next.upper=row===undefined?null:readPosition(row);}
  const oversizedIdentity=receiptExists(db,`${query} SELECT EXISTS(SELECT 1 FROM source_input WHERE length(CAST(sort_id AS BLOB))+length(CAST(id AS BLOB))+length(CAST(target AS BLOB))+length(CAST(turn AS BLOB))>${MAX_COMPLETION_METADATA_BYTES}) AS held`,runtime,gen);
  const heldReceiptHeads=decodeI64(receiptRow(db,`${query} SELECT COUNT(*) AS count FROM heads h WHERE EXISTS(SELECT 1 FROM unavailable r WHERE ${completionHeldMatch(source)})`,runtime,gen)?.count,"held receipt heads");
  if(next.upper===null){next.finished=true;return {cursor:cursor(next),page:Object.freeze({entries:Object.freeze([]),oversizedIdentity,heldReceiptHeads})};}
  const after=next.after??{stamp:0,ordinal:0n,id:""},upper=next.upper;
  const q=db.prepare(`${query} SELECT ${entryColumns} FROM candidates WHERE (?3=0 OR (stamp,ordinal,sort_id)>(?4,?5,?6)) AND (stamp,ordinal,sort_id)<=(?7,?8,?9) ORDER BY stamp,ordinal,sort_id LIMIT ${COMPLETION_PAGE_SIZE}`);q.setReadBigInts(true);
  const entries=Array.from(q.iterate(runtime,gen,next.after===null?0:1,after.stamp,after.ordinal,after.id,upper.stamp,upper.ordinal,upper.id),row=>readEntry(source,row));
  next.finished=entries.length<COMPLETION_PAGE_SIZE;if(entries.length>0)next.after=entries.at(-1)!.position;
  return {cursor:cursor(next),page:Object.freeze({entries:Object.freeze(entries),oversizedIdentity,heldReceiptHeads})};
}
/** Source standalone inventory API initializes the store; future scheduler read_round must use CheckedRead instead. */
export async function completionPage(path:string,source:CompletionSource,input:CompletionCursor,runtime:string,gen:bigint):Promise<CompletionPageRead>{
  text(path);requireCompletionSource(source);cursorData(input);text(runtime);generation(gen);const db=await openInitialized(path);
  try{db.exec("BEGIN DEFERRED");return completionPageIn(db,source,input,runtime,gen);}finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close abandons read */}}db.close();}
}
/** Pinned phase-1 ranks per channel BEFORE target filtering. Newer Rust delta is phase 2. */
export async function completionHeadsForTarget(path:string,target:string,runtime:string,gen:bigint):Promise<CompletionEntry[]>{
  for(const value of [path,target,runtime])text(value);generation(gen);const db=await openInitialized(path);
  try{db.exec("BEGIN DEFERRED");const result:CompletionEntry[]=[];
    for(const source of COMPLETION_SOURCES){if(completionSourceIsState(source))continue;
      const row=receiptRow(db,`${completionMetadataQuery(source)} SELECT ${entryColumns} FROM candidates WHERE target=?3 ORDER BY stamp,ordinal,sort_id LIMIT 1`,runtime,gen,target);
      if(row!==undefined)result.push(readEntry(source,row));
    }return result;
  }finally{if(db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close abandons read */}}db.close();}
}

/** Stable typed hint boundary; still no authority token. */
export function snapshotCompletionEntry(input:CompletionEntry):CompletionEntry{
  const field=(value:unknown,key:string):unknown=>{
    if(value===null||typeof value!=="object"||types.isProxy(value))throw new TypeError("Expected metadata record");
    const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own metadata field");return d.value;
  };
  const string=(value:unknown):string=>{text(value);return value;};
  const integer=(value:unknown):bigint=>{generation(value);return value;};
  const source=field(input,"source");requireCompletionSource(source);
  const rawPosition=field(input,"position"),stamp=field(rawPosition,"stamp");if(typeof stamp!=="number")throw new TypeError("Expected metadata timestamp");
  const position=Object.freeze({stamp,ordinal:integer(field(rawPosition,"ordinal")),id:string(field(rawPosition,"id"))});
  const bytes=field(input,"bytes");if(typeof bytes!=="bigint"||bytes<0n||bytes>=(1n<<64n))throw new TypeError("Expected usize metadata bytes");
  return Object.freeze({source,id:string(field(input,"id")),target:string(field(input,"target")),turn:string(field(input,"turn")),channel:integer(field(input,"channel")),bytes,position});
}
export function equalCompletionEntry(a:CompletionEntry,b:CompletionEntry):boolean{
  return sameCompletionIdentity(a,b)&&a.channel===b.channel&&a.bytes===b.bytes&&a.position.stamp===b.position.stamp&&a.position.ordinal===b.position.ordinal&&a.position.id===b.position.id;
}
export function currentCompletionEntryIn(db:DatabaseSync,input:CompletionEntry,runtime:string,gen:bigint):CompletionEntry|null{
  const entry=snapshotCompletionEntry(input);text(runtime);generation(gen);
  const final=entry.source==="Final";
  const row=receiptRow(db,`${completionMetadataQuery(entry.source,final)} SELECT ${entryColumns} FROM candidates WHERE id=?3 AND target=?4 AND turn=?5`,runtime,gen,entry.id,entry.target,entry.turn,...(final?[entry.channel]:[]));
  return row===undefined?null:readEntry(entry.source,row);
}
