const U64_MAX=18446744073709551615n;
function generation(value:bigint):void{if(typeof value!=='bigint'||value<0n||value>U64_MAX)throw new RangeError('Invalid remote generation');}
/** Rust runner generation.saturating_add(1), not wraparound. */
export function nextRemoteGeneration(value:bigint):bigint{generation(value);return value===U64_MAX?value:value+1n;}

/** One JS-owner diagnostic state. Clones share state, like the source Arc.
 * Native workers do not read this object: their owned messages carry generation.
 * This is not a cross-worker SharedArrayBuffer or session authority fence. */
export class RemoteAgentStatus {
 #state={connected:false,generation:0n};
 constructor(){Object.freeze(this);}
 clone():RemoteAgentStatus{const result=new RemoteAgentStatus();result.#state=this.#state;return result;}
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
 constructor(){Object.freeze(this);}
 clone():RemoteAgentControl{const result=new RemoteAgentControl();result.#state=this.#state;return result;}
 requestRestartHandoff():void{this.#state.restartHandoff=true;}
 restartHandoffRequested():boolean{return this.#state.restartHandoff;}
}
Object.freeze(RemoteAgentStatus.prototype);Object.freeze(RemoteAgentControl.prototype);
