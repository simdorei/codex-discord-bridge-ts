import {openSelectedForBindingOffThread,resolveThreadReferenceOffThread,readThreadExactOffThread} from '../codex-state/reference-reader.ts';
import {pinNativeRuntimePath} from './runtime-paths/path-text.ts';
import {requireDiscordText} from '../discord/text.ts';
import type {SettingsBindingReads} from './settings-binding.ts';
/** Existing reference slot, original selected snapshot, no selected fallback reread. */
export function createNativeSettingsBindingReads(statePath:string,bridgePath:string,mapped:SettingsBindingReads['mapped']):SettingsBindingReads{
 for(const p of [statePath,bridgePath]){requireDiscordText(p);if(p.includes('\0')||Buffer.byteLength(p)>32768)throw new TypeError('Invalid settings state path');}
 const state=pinNativeRuntimePath(statePath),bridge=pinNativeRuntimePath(bridgePath);
 return Object.freeze({openSelected:()=>openSelectedForBindingOffThread(state,bridge),resolve:(reference:string,selected:string|null)=>resolveThreadReferenceOffThread(state,reference,selected,false),exact:(id:string)=>readThreadExactOffThread(state,id,false),mapped});
}
