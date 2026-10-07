import {ClientLifecycle} from "./client-lifecycle.ts";
import {ClientRuntimeState} from "./runtime-state.ts";
export interface PendingCloseCleanup{transportClosedAll(reason:string):void|Promise<void>}
/** Logical transport close only. Preserves incoming requests/active turns for durable
 * dead-generation fencing; does not stop a child or certify process exit. */
export class ClientCloseCoordinator{
  readonly #lifecycle:ClientLifecycle;readonly #state:ClientRuntimeState;readonly #pending:PendingCloseCleanup;#closed=false;
  constructor(lifecycle:ClientLifecycle,state:ClientRuntimeState,pending:PendingCloseCleanup){this.#lifecycle=lifecycle;this.#state=state;this.#pending=pending;}
  get closed():boolean{return this.#closed;}
  async markClosed(observedReason:string):Promise<void>{
    const proposed=this.#lifecycle.sealAndResolveCloseReason(observedReason);this.#closed=true;
    const claim=this.#state.claimTransportClose(proposed);
    if(!claim.first)return;
    // Only the winner can publish. A loser must neither wait for nor bypass cleanup.
    await this.#pending.transportClosedAll(claim.reason);
    this.#lifecycle.publishClosed(claim.reason);
  }
}
