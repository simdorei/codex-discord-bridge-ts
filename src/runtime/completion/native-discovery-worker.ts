import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {CompletionDiscovery} from './scheduler/discovery.ts';
import {CompletionReady} from './scheduler/ready.ts';
import {discoveryText,discoveryI64,discoveryEntry,discoveryCursor,discoveryScan} from './native-discovery.ts';
export const runNativeOperation:ReusableNativeOperation=(q,port)=>{
try{
 if(boundedSerdeByteCount(q,16*1024*1024)===null)throw new TypeError('Oversize discovery request');discoveryText(q.path);discoveryText(q.runtime);discoveryI64(q.generation);
 if(!Array.isArray(q.state)||!Array.isArray(q.http)||q.state.length+q.http.length>128||!Array.isArray(q.active)||q.active.length>128||!Array.isArray(q.samples)||q.samples.length<1||q.samples.length>8||q.samples.some((n:unknown)=>typeof n!=='number'||!Number.isFinite(n)||n<0))throw new TypeError('Invalid discovery request');q.active.forEach(discoveryText);
 const ready=new CompletionReady<null>();for(const w of q.state){if(w.kind==='Live'){discoveryText(w.target);if(!ready.live({target:w.target,needsNative:false,payload:null,dispose(){}}))throw new TypeError('Invalid live prefix');}else if(w.kind==='Durable')ready.durable(discoveryEntry(w.entry),new Set());else throw new TypeError('Invalid state kind');}for(const e of q.http)ready.durable(discoveryEntry(e),new Set());
 if(ready.stateLength!==q.state.length||ready.httpLength!==q.http.length)throw new TypeError('Invalid ready prefix');
 let index=0,anchor=0;const now=()=>{if(index<q.samples.length){const n=q.samples[index++] as number;if(index===q.samples.length)anchor=performance.now();return n;}return (q.samples.at(-1) as number)+performance.now()-anchor;};
 const snapshot={rotation:q.snapshot.rotation,scans:q.snapshot.scans.map((s:unknown)=>discoveryScan(s,discoveryCursor))};
 const discovery=CompletionDiscovery.restoreNative(snapshot,now);
 // No awaits and no parent interaction from opening CheckedRead through its finish.
 const reports=discovery.read(q.path,q.runtime,q.generation,ready,new Set<string>(q.active));
 const state=ready.stateSnapshot().slice(q.state.length).map(w=>{if(w.kind!=='Durable')throw new TypeError('Unexpected live output');return w.entry;});
 const result={ok:true,state,http:ready.httpSnapshot().slice(q.http.length),scans:discovery.snapshotNative().scans,reports:reports.map(r=>r.ok?r:{source:r.source,ok:false})};
 if(boundedSerdeByteCount(result,16*1024*1024)===null)throw new Error('Discovery output exceeds boundary');port.postMessage(result);
}catch{port.postMessage({ok:false});}finally{port.close();}
};
await serveReusableWorker(runNativeOperation);
