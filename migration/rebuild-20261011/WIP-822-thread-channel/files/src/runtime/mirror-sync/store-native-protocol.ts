import type {MirrorCreationScope} from '../../store/mirror-creation.ts';
import type {MirrorThreadUpdate} from '../../store/mirror-mapping.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {ownContainerReceipt,type MirrorContainerReceipt} from '../../store/mirror-container-creation.ts';
import type {StaleMirrorThread,StaleMirrorProject} from '../../store/mirror-stale.ts';
import type {MirrorProjectMatch,MirrorProjectSnapshot} from '../../store/mirror-project-creation.ts';
export type MirrorStoreRequest=
 |{kind:'ThreadChannels';args:readonly [string]}
 |{kind:'ConfirmedThreadCreation'|'BeginThreadCreation';args:readonly [MirrorCreationScope]}
 |{kind:'ConfirmThreadCreation';args:readonly [MirrorCreationScope,string,bigint]}
 |{kind:'CommitThread';args:readonly [MirrorThreadUpdate,readonly [bigint,bigint]|null]}
 |{kind:'StaleThreads'|'StaleProjects';args:readonly [readonly string[],number]}
 |{kind:'RetireThread'|'RetireProject';args:readonly [string,bigint,number]}
 |{kind:'CategoryReceipt';args:readonly [bigint]}
 |{kind:'BeginCategory';args:readonly [bigint,MirrorContainerReceipt|null]}
 |{kind:'ConfirmContainer';args:readonly [MirrorContainerReceipt,bigint]}
 |{kind:'BindCategory';args:readonly [MirrorContainerReceipt]}
 |{kind:'FindProject';args:readonly [string|null]}
 |{kind:'ProjectForChannel';args:readonly [bigint|null]}
 |{kind:'ProjectSnapshot';args:readonly [string]}
 |{kind:'ProjectReceipt'|'BeginProject';args:readonly [string,bigint,bigint,MirrorProjectSnapshot]}
 |{kind:'ProjectAdoptable';args:readonly [bigint,bigint]}
 |{kind:'UpsertProject';args:readonly [string,string,bigint,number]}
 |{kind:'BeginCleanup';args:readonly [bigint,string|null,number]}
 |{kind:'CompleteCleanup'|'ReleaseCleanup';args:readonly [bigint,string]}
 |{kind:'CleanupPhase';args:readonly [bigint]}
 |{kind:'CleanupConfirmed';args:readonly [bigint,string]}
 |{kind:'UnconfirmedCleanup';args:readonly []}
 |{kind:'CleanupPending';args:readonly [bigint,string|null]};
export type MirrorStoreResult=readonly StaleMirrorThread[]|readonly StaleMirrorProject[]|MirrorContainerReceipt|MirrorProjectMatch|MirrorProjectSnapshot|readonly string[]|readonly bigint[]|string|bigint|boolean|null;
function text(v:unknown):asserts v is string {requireDiscordText(v);if(Buffer.byteLength(v)>16384)throw new RangeError('Mirror store text exceeds limit');}
function int(v:unknown):asserts v is bigint {if(typeof v!=='bigint'||v<-(1n<<63n)||v>=1n<<63n)throw new TypeError('Expected i64 mirror identity');}
function optionalText(v:unknown):void {if(v!==null)text(v);}
function number(v:unknown):void {if(typeof v!=='number'||!Number.isFinite(v))throw new TypeError('Expected finite mirror timestamp');}
function snapshot(v:unknown):void {if(!Array.isArray(v))throw new TypeError('Expected project snapshot');for(const pair of v){if(!Array.isArray(pair)||pair.length!==2)throw new TypeError('Expected project snapshot pair');text(pair[0]);int(pair[1]);}}
function mappingPair(v:unknown):void {if(v===null)return;if(!Array.isArray(v)||v.length!==2)throw new TypeError('Expected mirror mapping pair');int(v[0]);int(v[1]);}
function exactRecord(v:unknown,keys:readonly string[]):void {if(v===null||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))throw new TypeError('Expected exact mirror record');}
function creationScope(v:unknown):void {exactRecord(v,['thread','guild','parent','expected']);text(own(v,'thread'));int(own(v,'guild'));int(own(v,'parent'));mappingPair(own(v,'expected'));}
function threadUpdate(v:unknown):void {exactRecord(v,['threadId','projectKey','title','parentId','channelId','now']);for(const k of ['threadId','projectKey','title'])text(own(v,k));int(own(v,'parentId'));int(own(v,'channelId'));number(own(v,'now'));}
export function captureMirrorStoreRequest(input:MirrorStoreRequest):MirrorStoreRequest {
 if(boundedSerdeByteCount(input,262144)===null)throw new RangeError('Mirror store request exceeds limit');const q=cloneOwnedSerdeValue(input),kind=own(q,'kind'),args=own(q,'args');
 if(q===null||typeof q!=='object'||Array.isArray(q)||Object.keys(q).length!==2||!Array.isArray(args))throw new TypeError('Expected exact mirror request');
 const arity=(n:number)=>{if(args.length!==n)throw new TypeError('Wrong mirror argument count');};
 switch(kind){
  case 'ThreadChannels':arity(1);text(args[0]);break;
  case 'ConfirmedThreadCreation':case 'BeginThreadCreation':arity(1);creationScope(args[0]);break;
  case 'ConfirmThreadCreation':arity(3);creationScope(args[0]);text(args[1]);int(args[2]);break;
  case 'CommitThread':arity(2);threadUpdate(args[0]);mappingPair(args[1]);break;
  case 'StaleThreads':case 'StaleProjects':arity(2);if(!Array.isArray(args[0]))throw new TypeError('Expected valid identity array');for(const x of args[0])text(x);number(args[1]);break;
  case 'RetireThread':case 'RetireProject':arity(3);text(args[0]);int(args[1]);number(args[2]);break;
  case 'CategoryReceipt':case 'CleanupPhase':arity(1);int(args[0]);break;
  case 'BeginCategory':arity(2);int(args[0]);if(args[1]!==null)ownContainerReceipt(args[1]);break;
  case 'ConfirmContainer':arity(2);ownContainerReceipt(args[0]);int(args[1]);break;
  case 'BindCategory':arity(1);ownContainerReceipt(args[0]);break;
  case 'FindProject':arity(1);optionalText(args[0]);break;
  case 'ProjectForChannel':arity(1);if(args[0]!==null)int(args[0]);break;
  case 'ProjectSnapshot':arity(1);text(args[0]);break;
  case 'ProjectReceipt':case 'BeginProject':arity(4);text(args[0]);int(args[1]);int(args[2]);snapshot(args[3]);break;
  case 'ProjectAdoptable':arity(2);int(args[0]);int(args[1]);break;
  case 'UpsertProject':arity(4);text(args[0]);text(args[1]);int(args[2]);number(args[3]);break;
  case 'BeginCleanup':arity(3);int(args[0]);optionalText(args[1]);number(args[2]);break;
  case 'CompleteCleanup':case 'ReleaseCleanup':case 'CleanupConfirmed':arity(2);int(args[0]);text(args[1]);break;
  case 'UnconfirmedCleanup':arity(0);break;
  case 'CleanupPending':arity(2);int(args[0]);optionalText(args[1]);break;
  default:throw new TypeError('Unsupported mirror store request');
 }
 return q as MirrorStoreRequest;
}
export function captureMirrorStoreResult(kind:MirrorStoreRequest['kind'],input:unknown):MirrorStoreResult {
 if(boundedSerdeByteCount(input,2097152)===null)throw new RangeError('Mirror store reply exceeds limit');const v=cloneOwnedSerdeValue(input);
 switch(kind){
  case 'ThreadChannels':mappingPair(v);return v as readonly [bigint,bigint]|null;
  case 'ConfirmedThreadCreation':if(v!==null)int(v);return v as bigint|null;
  case 'BeginThreadCreation':text(v);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v))throw new TypeError('Invalid creation token');return v;
  case 'CategoryReceipt':case 'ProjectReceipt':if(v===null)return null;return ownContainerReceipt(v as MirrorContainerReceipt);
  case 'BeginCategory':case 'BeginProject':case 'ConfirmContainer':return ownContainerReceipt(v as MirrorContainerReceipt);
  case 'FindProject':if(v===null)return null;if(v===null||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==2||!Object.hasOwn(v,'channelId')||!Object.hasOwn(v,'storedKey'))throw new TypeError('Expected exact project match');int(own(v,'channelId'));text(own(v,'storedKey'));return v as MirrorProjectMatch;
  case 'ProjectForChannel':if(v===null)return null;if(!Array.isArray(v)||v.length!==2)throw new TypeError('Expected project identity pair');text(v[0]);text(v[1]);return v as readonly string[];
  case 'ProjectSnapshot':snapshot(v);return v as MirrorProjectSnapshot;
  case 'UpsertProject':if(!Array.isArray(v))throw new TypeError('Expected alias array');for(const x of v)text(x);return v as readonly string[];
  case 'UnconfirmedCleanup':if(!Array.isArray(v))throw new TypeError('Expected channel array');for(const x of v)int(x);return v as readonly bigint[];
  case 'StaleThreads':case 'StaleProjects':{
   if(!Array.isArray(v))throw new TypeError('Expected stale mapping array');
   const keys=kind==='StaleThreads'?['threadId','discordThreadId','title']:['projectKey','discordChannelId','projectName'];
   for(const row of v){if(row===null||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==3||keys.some(k=>!Object.hasOwn(row,k)))throw new TypeError('Expected exact stale mapping record');text(own(row,keys[0]!));int(own(row,keys[1]!));text(own(row,keys[2]!));}
   return v as readonly StaleMirrorThread[]|readonly StaleMirrorProject[];
  }
  case 'RetireThread':case 'RetireProject':case 'CleanupConfirmed':if(typeof v!=='boolean')throw new TypeError('Expected cleanup verification');return v;
  case 'BeginCleanup':text(v);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(v))throw new TypeError('Invalid cleanup token');return v;
  case 'CleanupPhase':case 'CleanupPending':if(v!==null)text(v);return v as string|null;
  default:if(v!==null)throw new TypeError('Expected empty write acknowledgement');return null;
 }
}
