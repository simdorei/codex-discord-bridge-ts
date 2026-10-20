import {setImmediate as yieldToRuntime} from 'node:timers/promises';
import {GatewayMessageDriver,type GatewayDriverMessage} from './message-driver.ts';
import {decodeGatewayEventText} from './event-decoder.ts';
import {GatewayPacketError} from './packet-control.ts';
import type {DecodedGatewayInteraction} from './decoded-interaction.ts';
import type {GatewayShardItem,GatewayShardPort} from './shard-task.ts';
const transferredDrivers=new WeakSet<GatewayMessageDriver>();
/** Transfers one raw driver's ownership into the existing typed shard port. Shared
 * identify queue lifetime stays with its caller. No discovery, live credentials,
 * runtime activation or command authorization happens in this constructor. The
 * caller must stop using the raw driver after this one-time transfer. */
export class GatewayDecodedShardPort implements GatewayShardPort<DecodedGatewayInteraction>{
 readonly shardId:number;
 readonly #receive:(signal?:AbortSignal)=>Promise<GatewayDriverMessage|null>;
 readonly #close:()=>void;readonly #disposeDriver:()=>Promise<void>;readonly #driverSnapshot:()=>ReturnType<GatewayMessageDriver['snapshot']>;
 readonly #stop=new AbortController();#read:Promise<GatewayShardItem<DecodedGatewayInteraction>|null>|undefined;#closing:Promise<void>|undefined;
 constructor(driver:GatewayMessageDriver){
  // Private-field brand validation, then capture actual implementation methods.
  const snapshot=GatewayMessageDriver.prototype.snapshot.call(driver);if(snapshot.disposed)throw new TypeError('Gateway driver already disposed');if(transferredDrivers.has(driver))throw new TypeError('Gateway driver already transferred');this.shardId=snapshot.shardId;
  this.#receive=GatewayMessageDriver.prototype.nextMessage.bind(driver);this.#close=GatewayMessageDriver.prototype.requestNormalClose.bind(driver);this.#disposeDriver=GatewayMessageDriver.prototype.dispose.bind(driver);this.#driverSnapshot=GatewayMessageDriver.prototype.snapshot.bind(driver);Object.freeze(this);transferredDrivers.add(driver);
 }
 snapshot(){return Object.freeze({pendingRead:this.#read!==undefined,disposed:this.#stop.signal.aborted,driver:this.#driverSnapshot()});}
 nextEvent(signal:AbortSignal):Promise<GatewayShardItem<DecodedGatewayInteraction>|null>{
  if(this.#stop.signal.aborted)throw new TypeError('Gateway shard port disposed');if(this.#read!==undefined)throw new TypeError('Concurrent decoded Gateway read');signal.throwIfAborted();
  const operation=this.#run(AbortSignal.any([signal,this.#stop.signal]));this.#read=operation;const clear=()=>{if(this.#read===operation)this.#read=undefined;};void operation.then(clear,clear);return operation;
 }
 async #run(signal:AbortSignal):Promise<GatewayShardItem<DecodedGatewayInteraction>|null>{
  let filtered=0;for(;;){signal.throwIfAborted();const message=await this.#receive(signal);if(message===null)return null;
   if(message.kind==='ReceiveError')return Object.freeze({kind:'ReceiveError',message:message.message});
   if(message.kind==='Close')return Object.freeze({kind:'Event',event:Object.freeze({kind:'GatewayClose'})});
   try{const event=decodeGatewayEventText(message.text);if(event!==null)return Object.freeze({kind:'Event',event});}
   catch(error){if(!(error instanceof GatewayPacketError)&&!(error instanceof SyntaxError)&&!(error instanceof RangeError))throw error;return Object.freeze({kind:'ReceiveError',message:'gateway event could not be deserialized: event='+message.text});}
   if(++filtered===64){filtered=0;await yieldToRuntime(undefined,{signal});}
  }
 }
 requestNormalClose():void{if(this.#stop.signal.aborted)throw new TypeError('Gateway shard port disposed');this.#close();}
 dispose():Promise<void>{
  if(this.#closing!==undefined)return this.#closing;this.#stop.abort(new Error('Gateway decoded shard disposed'));const read=this.#read;
  this.#closing=(async()=>{const results=await Promise.allSettled([this.#disposeDriver(),...(read===undefined?[]:[read])]);const cleanup=results[0]!;if(cleanup.status==='rejected')throw cleanup.reason;})();return this.#closing;
 }
}
