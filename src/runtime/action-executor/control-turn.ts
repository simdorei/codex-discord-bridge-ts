import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import type {BridgeState} from "../bridge-state.ts";
import type {TargetLocks,TargetLease} from "../../core/keyed-locks.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {InvalidActionRequestError,MissingActionAppServerError,NoActionTargetError,ActionIntegerRangeError} from "./errors.ts";
type Server=Pick<PortableResidentLifecycle,"generation"|"lifecycleSnapshot"|"activeTurnId">;
type Store=Pick<IStateAccessFacade,"hasObservedCompletion"|"mirroredThreadId">;
function text(v:unknown):void{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed control target");}
/** Read-only exact active-turn checks, never resume/fork/discovery. Cache absence
 * is unknown rather than idle. Caller retains shared target lease and final writer
 * must still bind the returned generation and original durable authority. */
export class ControlTurnVerifier{
  readonly #path:string;readonly #server:Server|null;readonly #bridge:Pick<BridgeState,"selectedThreadId">;readonly #locks:TargetLocks;readonly #state:Store;
  constructor(path:string,server:Server|null,bridge:Pick<BridgeState,"selectedThreadId">,locks:TargetLocks,state:Store=StateAccessFacade){text(path);this.#path=path;this.#server=server;this.#bridge=bridge;this.#locks=locks;this.#state=state;}
  lock(thread:string,signal?:AbortSignal):Promise<TargetLease>{return this.#locks.acquire(thread,signal);}
  async target(channel:bigint):Promise<string>{
    if(typeof channel!=="bigint"||channel<0n||channel>=(1n<<63n))throw new ActionIntegerRangeError();const mapped=await this.#state.mirroredThreadId(this.#path,channel);if(mapped!==null)return mapped;
    const selected=this.#bridge.selectedThreadId();if(selected===null)throw new NoActionTargetError();return selected;
  }
  async control(channel:bigint,thread:string,expected:string|null=null):Promise<readonly [string,bigint]>{text(thread);if(await this.target(channel)!==thread)throw new InvalidActionRequestError("control target changed; select the current thread again");return this.owned(thread,expected);}
  async owned(thread:string,expected:string|null=null):Promise<readonly [string,bigint]>{
    text(thread);if(expected!==null)text(expected);const server=this.#server;if(server===null)throw new MissingActionAppServerError();const generation=server.generation(),snapshot=server.lifecycleSnapshot();
    if(!snapshot.healthy||snapshot.quarantined||snapshot.restartPending)throw new InvalidActionRequestError("Codex connection is not ready; active turn is unknown. Retry after reconnect.");
    const turn=await server.activeTurnId(thread);if(turn===null)throw new InvalidActionRequestError("no currently owned active turn is confirmed; the task may be preparing, finished, or reconnecting. Retry the control when it is active.");
    if(expected!==null&&expected!==turn)throw new InvalidActionRequestError("the original turn has ended; this button will not steer a later turn. Send a new request.");
    if(server.generation()!==generation||await this.#state.hasObservedCompletion(this.#path,thread,turn))throw new InvalidActionRequestError("turn completed or connection changed while checking; no control was sent");return Object.freeze([turn,generation] as const);
  }
}
