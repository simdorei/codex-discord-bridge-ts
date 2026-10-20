import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {compareUtf8Bytes,validateTarget,type RestartReadinessSnapshot} from './restart-snapshot-pure.ts';
/** Capture and validate the canonical owned durable snapshot shared by live drain and maintenance inspection. */
export function captureRestartSnapshot(value:unknown):RestartReadinessSnapshot{
 const v=cloneOwnedSerdeValue(value);const strings=(key:string,targets=false)=>{const a=own(v,key);if(!Array.isArray(a))throw new TypeError('Expected restart snapshot array');const out=a.map(x=>{requireDiscordText(x);if(targets)validateTarget(x);return x;});for(let i=1;i<out.length;i++)if(compareUtf8Bytes(out[i-1]!,out[i]!)>(targets?-1:0))throw new TypeError('Restart snapshot is not canonical');return Object.freeze(out);};
 return Object.freeze({targetThreadIds:strings('targetThreadIds',true),blockers:strings('blockers'),observations:strings('observations')});
}
