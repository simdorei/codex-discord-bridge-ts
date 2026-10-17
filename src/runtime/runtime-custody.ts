import {NativeDeadGenerationOwner} from "./native-dead-generation.ts";
import {pinNativeRuntimePath} from "./runtime-paths/path-text.ts";
import {I64_MAX} from "../protocol/ids.ts";
import {cloneDeadGenerationWork,serializeDeadGenerationWork,type DeadGenerationWork} from "../app-server/dead-generation-work.ts";
import {extractThreadId} from "../app-server/identity.ts";
import {createRuntimeFenceErrors} from "./fence-errors.ts";
import {StateAccessFacade as state} from "../store/state-access-facade.ts";
import {createMutationCustodyFence} from "./mutation-custody-fence.ts";

function text(v:unknown):v is string{return typeof v==="string"&&!/[\uD800-\uDFFF]/u.test(v);}
/** Call only after the bot single-instance guard and before any resident/queue worker.
 * Keep that actual guard held across activation, spawn and initialize handshake.
 * Activation is deliberately two ordered operations, as in RuntimeDeadGenerationFence::new.
 * Returned persistence is a trusted resident hook, not a public proof/consent decoder.
 * The caller still supplies its actual owned-exit hook and installs the idle journal. */
export async function initializeRuntimeCustody(path:string,runtime:string,startupChannel:bigint|null,renderError:(error:unknown)=>string,signal?:AbortSignal){
  if(!text(path)||!text(runtime)||(startupChannel!==null&&(typeof startupChannel!=="bigint"||startupChannel<0n||startupChannel>I64_MAX)))throw new TypeError("Expected runtime path, identity and optional startup channel fitting i64");
  path=pinNativeRuntimePath(path);
  const errors=createRuntimeFenceErrors(renderError);
  const mapped=<T>(operation:()=>T):T=>errors.run("DeadGenerationFence",operation);
  // Pin compatibility hooks and the same original path before native startup.
  const capture=state.captureDeadGenerationExisting,fence=mapped(()=>createMutationCustodyFence(path,runtime,renderError));
  const persistDeadWork=(_instanceId:string,input:DeadGenerationWork):void=>mapped(()=>{
    const work=cloneDeadGenerationWork(input);if(work.generation>I64_MAX)throw new RangeError("Dead generation does not fit signed i64");
    const scoped=work.serverRequests.map(r=>extractThreadId(r.params)),targets=[...work.activeTurns.map(t=>t.threadId),...scoped.filter((t):t is string=>t!==null)];
    capture(path,{runtimeId:runtime,generation:work.generation,snapshotJson:serializeDeadGenerationWork(work),affectedTargets:targets,startupChannelId:startupChannel,hasUnscopedRequests:scoped.some(t=>t===null),now:Date.now()/1000});
  });
  const nativeDeadGeneration=await NativeDeadGenerationOwner.startWithCustodyActivation(path,runtime,startupChannel,renderError,signal);
  return Object.freeze({fence,persistDeadWork,nativeDeadGeneration});
}
