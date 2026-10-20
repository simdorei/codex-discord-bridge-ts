import {isMirrorBootstrapReconciliationRequiredError} from './bootstrap-coordinator.ts';
import type {MirrorTargetFinished} from './execution.ts';

/** Cancellation and timeout classification must not hide the joined write result. */
export function mirrorBootstrapRequiresReconciliation(finished:MirrorTargetFinished):boolean{
 const outcome=finished.outcome,settled=outcome.kind==='Cancelled'||outcome.kind==='TimedOut'?outcome.settled:outcome;
 return settled.kind==='Failed'&&isMirrorBootstrapReconciliationRequiredError(settled.error);
}

const heldErrors=new WeakSet<object>();
export function isMirrorBootstrapWorkerHeldError(value:unknown):value is MirrorBootstrapWorkerHeldError{
 return value!==null&&typeof value==='object'&&heldErrors.has(value);
}

/** Terminal for this worker invocation. Retains the original packets, including
 * every harvested peer result; no automatic target retry or new epoch is safe.
 * A caller must explicitly reconcile before deciding whether to start again. */
export class MirrorBootstrapWorkerHeldError extends Error{
 readonly finished:readonly MirrorTargetFinished[];
 constructor(finished:readonly MirrorTargetFinished[]){
  super('Mirror worker held for explicit startup-write reconciliation; automatic retry stopped');
  this.name='MirrorBootstrapWorkerHeldError';this.finished=Object.freeze([...finished]);heldErrors.add(this);Object.freeze(this);
 }
}
