import type {ResidentMaintenanceFence} from '../app-server/maintenance-transport.ts';
import type {ResidentPersistence} from '../app-server/portable-resident-lifecycle.ts';
import {cloneDeadGenerationWork,serializeDeadGenerationWork,type DeadGenerationWork} from '../app-server/dead-generation-work.ts';
import {extractThreadId} from '../app-server/identity.ts';
import {StateAccessFacade as state} from '../store/state-access-facade.ts';
import {I64_MAX} from '../protocol/ids.ts';
import {requirePersistentResidentRole} from './persistent-resident-bootstrap.ts';
import {createMutationCustodyFence} from './mutation-custody-fence.ts';
import {createRuntimeFenceErrors} from './fence-errors.ts';

const render=()=> 'Disposable resident operation unavailable';
/** Fixed resident-local bindings. No caller-supplied store path or authority hooks. */
export function preparePersistentResidentLocalCustody(runtime:string):Readonly<{
 path:string;
 fence:ResidentMaintenanceFence;
 persistDeadWork:ResidentPersistence['persistDeadWork'];
}>{
 const descriptor=requirePersistentResidentRole(),path=descriptor.path;
 const errors=createRuntimeFenceErrors(render),mapped=<T>(operation:()=>T):T=>errors.run('DeadGenerationFence',operation);
 // These exact local hooks exist before custody activation and before child spawn.
 const fence=mapped(()=>createMutationCustodyFence(path,runtime,render));
 const capture=state.captureDeadGenerationExisting;
 const persistDeadWork=(_instanceId:string,input:DeadGenerationWork):void=>mapped(()=>{
  const work=cloneDeadGenerationWork(input);if(work.generation>I64_MAX)throw new RangeError('Generation exceeds signed i64');
  const scoped=work.serverRequests.map(r=>extractThreadId(r.params));
  capture(path,{runtimeId:runtime,generation:work.generation,snapshotJson:serializeDeadGenerationWork(work),affectedTargets:[...work.activeTurns.map(t=>t.threadId),...scoped.filter((t):t is string=>t!==null)],startupChannelId:null,hasUnscopedRequests:scoped.some(t=>t===null),now:Date.now()/1000});
 });
 return Object.freeze({path,fence,persistDeadWork});
}
