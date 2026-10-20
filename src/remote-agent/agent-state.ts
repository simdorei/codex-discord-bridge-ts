const U64_MAX=18446744073709551615n;
const statusStates=new WeakMap<object,object>(),controlStates=new WeakMap<object,object>();
const claimedStatuses=new WeakSet<object>(),claimedControls=new WeakSet<object>();
function generation(value:bigint):void{if(typeof value!=='bigint'||value<0n||value>U64_MAX)throw new RangeError('Invalid remote generation');}
/** Rust runner generation.saturating_add(1), not wraparound. */
export function nextRemoteGeneration(value:bigint):bigint{generation(value);return value===U64_MAX?value:value+1n;}

/** One JS-owner diagnostic state. Clones share state, like the source Arc.
 * Native workers do not read this object: their owned messages carry generation.
 * This is not a cross-worker SharedArrayBuffer or session authority fence. */
export class RemoteAgentStatus {
 #state={connected:false,generation:0n};
 constructor(){statusStates.set(this,this.#state);Object.freeze(this);}
 clone():RemoteAgentStatus{const result=new RemoteAgentStatus();result.#state=this.#state;statusStates.set(result,this.#state);return result;}
 isConnected():boolean{return this.#state.connected;}
 generation():bigint{return this.#state.generation;}
 setConnected(value:bigint):void{generation(value);this.#state.generation=value;this.#state.connected=true;}
 setDisconnected():void{this.#state.connected=false;}
 snapshot(){return Object.freeze({connected:this.#state.connected,generation:this.#state.generation});}
}
/** Explicit restart-handoff request only. No reset, automatic Reserve, restart,
 * marker write or session transfer is performed by setting this flag. */
export class RemoteAgentControl {
 #state={restartHandoff:false};
 constructor(){controlStates.set(this,this.#state);Object.freeze(this);}
 clone():RemoteAgentControl{const result=new RemoteAgentControl();result.#state=this.#state;controlStates.set(result,this.#state);return result;}
 requestRestartHandoff():void{this.#state.restartHandoff=true;}
 restartHandoffRequested():boolean{return this.#state.restartHandoff;}
}
/** Atomically claim the shared states for one managed lifetime, including all
 * clones. Never release/recycle them: a fresh lifetime needs fresh generation
 * diagnostics and restart control, even after failed preparation. */
export function claimManagedRemoteState(status:RemoteAgentStatus,control:RemoteAgentControl):void{
 const s=statusStates.get(status),c=controlStates.get(control);
 if(s===undefined||c===undefined)throw new TypeError('Expected authentic shared remote state');
 if(claimedStatuses.has(s)||claimedControls.has(c))throw new TypeError('Shared remote state already belongs to a managed owner');
 claimedStatuses.add(s);claimedControls.add(c);
}
Object.freeze(RemoteAgentStatus.prototype);Object.freeze(RemoteAgentControl.prototype);
