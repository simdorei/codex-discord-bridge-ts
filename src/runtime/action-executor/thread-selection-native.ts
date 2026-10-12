import {resolveThreadReferenceOffThread,readThreadExactOffThread} from '../../codex-state/reference-reader.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {ActionThreadReads} from './thread-selection.ts';
/** Installs readonly existing-store readers; no selected-state write or RPC. */
export function createNativeActionThreadReads(path:string,bridgePath:string):ActionThreadReads{
 for(const p of [path,bridgePath]){requireDiscordText(p);if(p.includes('\0')||Buffer.byteLength(p)>32768)throw new TypeError('Invalid thread read binding');}
 const fixed=pinNativeRuntimePath(path),bridge=pinNativeRuntimePath(bridgePath);
 return Object.freeze({resolve:(reference:string,archived:boolean,signal?:AbortSignal)=>resolveThreadReferenceOffThread(fixed,reference,null,archived,signal,6000,bridge),exact:(id:string,archived:boolean,signal?:AbortSignal)=>readThreadExactOffThread(fixed,id,archived,signal)});
}
