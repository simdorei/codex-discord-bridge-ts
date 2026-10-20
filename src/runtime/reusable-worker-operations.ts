import type {WorkerReplyPort} from './reusable-worker-entry.ts';
export type ReusableNativeOperation=(input:any,reply:WorkerReplyPort)=>void|Promise<void>;
// Literal imports are the closed dispatch surface. No request controls a module
// import, filesystem destination, or source expression.
const operations:readonly (readonly [string,()=>Promise<{runNativeOperation:ReusableNativeOperation}>])[]=[
 ['action-executor/stop-pending-native-worker.ts',()=>import('./action-executor/stop-pending-native-worker.ts')],
 ['completion/native-discovery-worker.ts',()=>import('./completion/native-discovery-worker.ts')],
 ['completion/native-idle-inventory-worker.ts',()=>import('./completion/native-idle-inventory-worker.ts')],
 ['completion/native-typing-worker.ts',()=>import('./completion/native-typing-worker.ts')],
 ['discord-runtime/history-target-worker.ts',()=>import('./discord-runtime/history-target-worker.ts')],
 ['discord-runtime/mirror-policy-worker.ts',()=>import('./discord-runtime/mirror-policy-worker.ts')],
 ['native-observation-ledger-worker.ts',()=>import('./native-observation-ledger-worker.ts')],
 ['new-reply/store-worker.ts',()=>import('./new-reply/store-worker.ts')],
 ['session-mirror/discovery-worker.ts',()=>import('./session-mirror/discovery-worker.ts')],
 ['session-mirror/store-discovery-worker.ts',()=>import('./session-mirror/store-discovery-worker.ts')],
 ['session-mirror/startup-intent-store-worker.ts',()=>import('./session-mirror/startup-intent-store-worker.ts')],
 ['session-mirror/cursor-store-worker.ts',()=>import('./session-mirror/cursor-store-worker.ts')],
 ['session-mirror/decode-worker.ts',()=>import('./session-mirror/decode-worker.ts')],
 ['message-worker/native-classification-worker.ts',()=>import('./message-worker/native-classification-worker.ts')],
 ['../discord/history-page-worker.ts',()=>import('../discord/history-page-worker.ts')],
 ['message-worker/native-journal-worker.ts',()=>import('./message-worker/native-journal-worker.ts')],
 ['prompt-intake/native-state-worker.ts',()=>import('./prompt-intake/native-state-worker.ts')],
 ['native-mutation-worker.ts',()=>import('./native-mutation-worker.ts')],
 ['queue-runner/native-read-state-worker.ts',()=>import('./queue-runner/native-read-state-worker.ts')],
 ['queue-runner/native-attempt-worker.ts',()=>import('./queue-runner/native-attempt-worker.ts')],
 ['queue-runner/native-submission-worker.ts',()=>import('./queue-runner/native-submission-worker.ts')],
 ['native-idle-before-worker.ts',()=>import('./native-idle-before-worker.ts')],
 ['completion/native-heads-worker.ts',()=>import('./completion/native-heads-worker.ts')],
 ['completion/native-owner-read-worker.ts',()=>import('./completion/native-owner-read-worker.ts')],
 ['completion/native-history-read-worker.ts',()=>import('./completion/native-history-read-worker.ts')],
 ['completion/native-http-payload-worker.ts',()=>import('./completion/native-http-payload-worker.ts')],
 ['completion/native-final-state-worker.ts',()=>import('./completion/native-final-state-worker.ts')],
 ['completion/native-receipt-store-worker.ts',()=>import('./completion/native-receipt-store-worker.ts')],
 ['bridge-state-native-worker.ts',()=>import('./bridge-state-native-worker.ts')],
];
const extension=import.meta.url.endsWith('.js')?'.js':'.ts';
const loaders=new Map(operations.map(([path,load])=>[new URL(path.replace(/\.ts$/,extension),import.meta.url).href,load]));
export function hasReusableWorkerOperation(url:URL):boolean{return loaders.has(url.href);}
export async function loadReusableWorkerOperation(url:URL):Promise<ReusableNativeOperation>{
 const load=loaders.get(url.href);if(load===undefined)throw new TypeError('Unreviewed reusable native operation');
 return (await load()).runNativeOperation;
}
