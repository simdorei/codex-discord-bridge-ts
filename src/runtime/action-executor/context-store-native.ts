import {probeContextStoreOffThread,readContextInventoryOffThread} from '../../codex-state/reference-reader.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {ContextStoreReads} from './context-action.ts';
/** Bind existing-only state reads before any await. No selected-state mutation. */
export function createNativeContextStoreReads(path:string):ContextStoreReads{
 requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid Context state path');const fixed=pinNativeRuntimePath(path);
 return Object.freeze({probe:(signal?:AbortSignal)=>probeContextStoreOffThread(fixed,signal),recent:(limit:bigint,signal?:AbortSignal)=>readContextInventoryOffThread(fixed,limit,signal)});
}
