import {types} from 'node:util';
import {SecretToken} from '../../config/remote.ts';
import {GatewaySessionMachine,type GatewayResumeSession,type GatewayIdentifyTicket} from './session-machine.ts';
import {GatewayPacketError,gatewayReconnectDelayMs} from './packet-control.ts';
import {GatewayControlEncoder} from './control-encoder.ts';
import {sendGatewayControl} from './control-sender.ts';
import {GatewayCommandRateLimiter,gatewayControlNeedsPermit} from './command-rate.ts';
import {SingleBucketGatewayIdentifyQueue} from './identify-queue.ts';
import {NodeGatewayWebSocket,gatewaySendFailureStage,type GatewaySocketMessage} from './node-websocket.ts';
import {GatewayZstdDecoder,GatewayCompressionError} from './zstd.ts';
export interface GatewayDriverClock{nowNs():bigint;sleepUntilNs(deadline:bigint,signal:AbortSignal):Promise<void>}
export const nativeGatewayDriverClock:GatewayDriverClock=Object.freeze({nowNs:()=>process.hrtime.bigint(),sleepUntilNs:(deadline:bigint,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 let timer:ReturnType<typeof setTimeout>|undefined;const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};const abort=()=>{clean();reject(signal.reason);};const check=()=>{if(signal.aborted){abort();return;}const remaining=deadline-process.hrtime.bigint();if(remaining<=0n){clean();resolve();return;}const milliseconds=(remaining+999999n)/1000000n;timer=setTimeout(check,Number(milliseconds>2147483647n?2147483647n:milliseconds));};signal.addEventListener('abort',abort,{once:true});check();
})});
export type GatewayDriverMessage={readonly kind:'Text';readonly text:string}|{readonly kind:'Close';readonly code:number;readonly reason:Uint8Array}|{readonly kind:'ReceiveError';readonly message:string};
interface ReadSlot{promise:Promise<void>;ready:boolean;message:GatewaySocketMessage|null;failed:boolean}
interface IdentifySlot{ticket:GatewayIdentifyTicket;cancel:AbortController;promise:Promise<void>;ready:boolean;failed:boolean;error:unknown}
/** Owns bridge-profile raw Gateway sessions, not full dispatch decoding. Starts
 * lazily on first nextMessage; its single output slot bounds prefetch to one item.
 * Queue lifetime belongs to the caller and is shared across shard owners.
 * Jitter and a clock are explicit policies. The default transport uses official
 * WSS hosts; injected connection factories are for controlled tests/adapters. */
export class GatewayMessageDriver{
 readonly #machine:GatewaySessionMachine;readonly #encoder:GatewayControlEncoder;readonly #queue:SingleBucketGatewayIdentifyQueue;readonly #clock:GatewayDriverClock;readonly #connect:(url:string,signal:AbortSignal)=>Promise<NodeGatewayWebSocket>;readonly #shard:number;
 readonly #stop=new AbortController();readonly #retiring=new Set<NodeGatewayWebSocket>();readonly #identifyOperations=new Set<Promise<void>>();readonly #waiters=new Set<()=>void>();#slot:GatewayDriverMessage|null=null;#reading=false;#disposed=false;#done=false;#failed=false;#failure:unknown;#pump:Promise<void>|undefined;#closing:Promise<void>|undefined;
 #wire:NodeGatewayWebSocket|null=null;#decoder:GatewayZstdDecoder|null=null;#read:ReadSlot|null=null;#identify:IdentifySlot|null=null;#rate:GatewayCommandRateLimiter|null=null;#schedule:ReturnType<GatewaySessionMachine['heartbeatSchedule']>=null;#heartbeatAt:bigint|null=null;#closeRequested=false;#normalClosing=false;#attempt=0;
 constructor(options:{token:SecretToken;shardNumber:number;shardTotal:number;messageContent:boolean;identifyQueue:SingleBucketGatewayIdentifyQueue;jitter:(intervalNs:bigint)=>bigint;clock?:GatewayDriverClock;connect?:(url:string,signal:AbortSignal)=>Promise<NodeGatewayWebSocket>;session?:GatewayResumeSession;resumeUrl?:string}){
  this.#encoder=new GatewayControlEncoder(options);this.#machine=new GatewaySessionMachine(options);this.#queue=options.identifyQueue;this.#shard=options.shardNumber;
  const clock=options.clock??nativeGatewayDriverClock;this.#clock=Object.freeze({nowNs:clock.nowNs.bind(clock),sleepUntilNs:clock.sleepUntilNs.bind(clock)});
  const connect=options.connect??((url,signal)=>NodeGatewayWebSocket.connect(url,{signal}));if(typeof connect!=='function'||types.isProxy(connect))throw new TypeError('Expected Gateway connector');this.#connect=connect;
 }
 snapshot(){return Object.freeze({phase:this.#machine.phase,identified:this.#machine.identified,attempt:this.#attempt,hasSession:this.#machine.resumeSession()!==null,disposed:this.#disposed,done:this.#done,queuedMessage:this.#slot!==null,ownedSockets:(this.#wire?.ownedSockets??0)+[...this.#retiring].reduce((sum,wire)=>sum+wire.ownedSockets,0)});}
 #notify():void{for(const wake of [...this.#waiters])wake();}
 #wait(signal:AbortSignal):Promise<void>{return new Promise((resolve,reject)=>{const clean=()=>{this.#waiters.delete(wake);signal.removeEventListener('abort',abort);};const wake=()=>{clean();resolve();};const abort=()=>{clean();reject(signal.reason);};this.#waiters.add(wake);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
 #start():void{if(this.#pump!==undefined)return;this.#pump=(async()=>{try{await this.#run();}catch(error){if(!this.#disposed){this.#failed=true;this.#failure=error;}}finally{try{await this.#dropConnection();}catch(error){if(!this.#failed){this.#failed=true;this.#failure=error;}}this.#done=true;this.#notify();}})();}
 async nextMessage(signal?:AbortSignal):Promise<GatewayDriverMessage|null>{
  if(this.#reading)throw new TypeError('Concurrent Gateway driver receive');if(this.#disposed)throw new TypeError('Gateway driver disposed');signal?.throwIfAborted();this.#reading=true;const combined=signal===undefined?this.#stop.signal:AbortSignal.any([signal,this.#stop.signal]);this.#start();
  try{for(;;){combined.throwIfAborted();if(this.#slot!==null){const value=this.#slot;this.#slot=null;this.#notify();return value;}if(this.#done){if(this.#failed)throw this.#failure;return null;}await this.#wait(combined);}}finally{this.#reading=false;}
 }
 requestNormalClose():void{if(this.#disposed)throw new TypeError('Gateway driver disposed');this.#closeRequested=true;this.#notify();}
 async #publish(message:GatewayDriverMessage):Promise<void>{this.#stop.signal.throwIfAborted();if(this.#slot!==null)throw new Error('Gateway output slot already occupied');this.#slot=Object.freeze(message);this.#notify();while(this.#slot!==null)await this.#wait(this.#stop.signal);}
 async #dropConnection():Promise<void>{
  const wire=this.#wire,decoder=this.#decoder,read=this.#read,identify=this.#identify;this.#wire=null;this.#decoder=null;this.#read=null;this.#identify=null;this.#rate=null;this.#schedule=null;this.#heartbeatAt=null;
  identify?.cancel.abort(new Error('Gateway connection ended'));if(wire!==null)this.#retiring.add(wire);try{await Promise.all([wire?.dispose(),decoder?.dispose(),read?.promise,...this.#identifyOperations]);}finally{if(wire!==null)this.#retiring.delete(wire);}
 }
 #sync():void{
  const schedule=this.#machine.heartbeatSchedule();if(schedule!==this.#schedule){this.#schedule=schedule;this.#heartbeatAt=schedule?.firstAtNs??null;if(schedule===null)this.#rate=null;else this.#rate=new GatewayCommandRateLimiter(schedule.intervalNs,this.#clock.nowNs());}
  const ticket=this.#machine.identifyRequest();if(ticket===this.#identify?.ticket)return;
  this.#identify?.cancel.abort(new Error('Gateway identify request replaced'));this.#identify=null;
  if(ticket!==null){const cancel=new AbortController(),slot:IdentifySlot={ticket,cancel,promise:Promise.resolve(),ready:false,failed:false,error:undefined};slot.promise=this.#queue.enqueue(this.#shard,cancel.signal).then(()=>{slot.ready=true;this.#notify();},error=>{slot.ready=true;slot.failed=true;slot.error=error;this.#notify();});this.#identifyOperations.add(slot.promise);void slot.promise.then(()=>this.#identifyOperations.delete(slot.promise));this.#identify=slot;}
 }
 #beginRead():void{if(this.#read!==null)return;const slot:ReadSlot={promise:Promise.resolve(),ready:false,message:null,failed:false};slot.promise=this.#wire!.receive().then(message=>{slot.message=message;slot.ready=true;this.#notify();},()=>{slot.failed=true;slot.ready=true;this.#notify();});this.#read=slot;}
 async #idleWait():Promise<void>{
  const now=this.#clock.nowNs();let deadline=this.#heartbeatAt;
  if(this.#identify?.ready&&!this.#identify.failed&&this.#rate!==null){const rateAt=this.#rate.readyAtNs(now);if(rateAt>now&&(deadline===null||rateAt<deadline))deadline=rateAt;}
  const cancel=new AbortController(),signal=AbortSignal.any([this.#stop.signal,cancel.signal]);const notification=this.#wait(signal).then(()=>({ok:true as const}),error=>({ok:false as const,error}));const timer=deadline===null?null:this.#clock.sleepUntilNs(deadline,signal).then(()=>({ok:true as const}),error=>({ok:false as const,error}));
  const result=await(timer===null?notification:Promise.race([notification,timer]));cancel.abort(new Error('Gateway wake selected'));await Promise.all([notification,timer]);if(!result.ok)throw result.error;
 }
 async #abnormal():Promise<void>{await this.#dropConnection();await this.#publish({kind:'Close',code:1006,reason:new Uint8Array()});}
 async #run():Promise<void>{
  const signal=this.#stop.signal;
  for(;;){
   signal.throwIfAborted();
   if(this.#wire===null){
    if(this.#machine.phase==='FatallyClosed'||this.#normalClosing)return;
    await this.#clock.sleepUntilNs(this.#clock.nowNs()+BigInt(gatewayReconnectDelayMs(this.#attempt))*1000000n,signal);
    try{const base=this.#machine.resumeUrl??'wss://gateway.discord.gg';this.#wire=await this.#connect(base+'/?v=10&encoding=json&compress=zstd-stream',signal);signal.throwIfAborted();}
    catch(error){signal.throwIfAborted();await this.#dropConnection();this.#machine.connectionFailed();if(this.#attempt===255)throw new RangeError('Gateway reconnect attempt exhausted u8 profile');this.#attempt++;await this.#publish({kind:'ReceiveError',message:'failed to reconnect to the gateway'});continue;}
    this.#decoder=new GatewayZstdDecoder();this.#machine.connected();this.#attempt=0;
   }
   this.#sync();
   const command=this.#machine.takeCommand();
   if(command!==null){
    try{if(gatewayControlNeedsPermit(command.command)&&this.#rate!==null){while(!this.#rate.tryAcquire(this.#clock.nowNs()))await this.#clock.sleepUntilNs(this.#rate.readyAtNs(this.#clock.nowNs()),signal);}signal.throwIfAborted();await sendGatewayControl({machine:this.#machine,ticket:command,encoder:this.#encoder,wire:this.#wire!,nowNs:this.#clock.nowNs});}
    catch(error){signal.throwIfAborted();if(gatewaySendFailureStage(error)===null)throw error;if(this.#machine.isCurrentCommand(command))this.#machine.commandFailed(command,'BeforePayload');await this.#abnormal();}
    continue;
   }
   if(this.#closeRequested&&this.#machine.phase!=='Disconnected'){this.#closeRequested=false;this.#normalClosing=true;this.#machine.requestClose(1000);continue;}
   const now=this.#clock.nowNs();if(this.#heartbeatAt!==null&&now>=this.#heartbeatAt){const outcome=this.#machine.heartbeatTick();if(outcome==='Zombie'){await this.#abnormal();continue;}this.#heartbeatAt=now+this.#schedule!.intervalNs;continue;}
   if(this.#identify?.ready){const identify=this.#identify;if(identify.failed)throw identify.error;if(this.#rate===null||this.#rate.readyAtNs(now)<=now){this.#identify=null;this.#machine.identifyGranted(identify.ticket);continue;}}
   this.#beginRead();const read=this.#read!;
   if(!read.ready){await this.#idleWait();continue;}
   this.#read=null;
   if(read.failed||read.message===null){this.#machine.transportFailed();await this.#abnormal();continue;}
   const message=read.message;
   if(message.kind==='Close'){this.#machine.gatewayClosed(message.code);await this.#dropConnection();await this.#publish(message);continue;}
   let text:string;
   if(message.kind==='Text')text=message.text;
   else{try{text=await this.#decoder!.decompress(message.bytes,signal);}catch(error){signal.throwIfAborted();if(!(error instanceof GatewayCompressionError))throw error;this.#machine.requestClose(4000);this.#sync();await this.#publish({kind:'ReceiveError',message:'binary message could not be decompressed'});continue;}}
   try{this.#machine.processPacket(text,this.#clock.nowNs());this.#sync();}catch(error){if(!(error instanceof GatewayPacketError))throw error;await this.#publish({kind:'ReceiveError',message:'gateway event could not be deserialized: event='+text});continue;}
   await this.#publish({kind:'Text',text});
  }
 }
 dispose():Promise<void>{if(this.#closing!==undefined)return this.#closing;this.#disposed=true;this.#stop.abort(new Error('Gateway message driver disposed'));this.#slot=null;this.#notify();const cleanup=this.#dropConnection();this.#closing=(async()=>{await Promise.all([cleanup,this.#pump]);})();return this.#closing;}
}
