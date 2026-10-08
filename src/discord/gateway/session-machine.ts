import {types} from 'node:util';
import {scanGatewayPacket,decodeGatewaySessionControl,gatewayCloseAllowsReconnect,gatewayLocalCloseRetainsSession,type GatewaySessionControl} from './packet-control.ts';
export type GatewaySessionPhase='Disconnected'|'Identifying'|'Active'|'Resuming'|'FatallyClosed';
export interface GatewayResumeSession{readonly id:string;readonly sequence:bigint}
export type GatewayControlCommand={readonly kind:'Heartbeat';readonly sequence:bigint|null}|{readonly kind:'Identify'}|{readonly kind:'Resume';readonly sessionId:string;readonly sequence:bigint}|{readonly kind:'Close';readonly code:number}|{readonly kind:'FlushOnly';readonly heartbeat:boolean};
export interface GatewayIdentifyTicket{readonly kind:"GatewayIdentifyTicket"}
export interface GatewayCommandTicket{readonly command:GatewayControlCommand}
export interface GatewayHeartbeatSchedule{readonly intervalNs:bigint;readonly firstAtNs:bigint}
/** Central pure session/control state. Caller owns actual timers, identify queue,
 * rate permits, socket flush and full event admission. Times are monotonic integer
 * nanoseconds; the jitter supplier is a required trusted synchronous policy.
 * Send completion is explicit; a command is never replayed after a failed flush. */
export class GatewaySessionMachine{
 #phase:GatewaySessionPhase='Disconnected';#session:GatewayResumeSession|null;#resumeUrl:string|null;#schedule:GatewayHeartbeatSchedule|null=null;#identify:GatewayIdentifyTicket|null=null;#pending:GatewayControlCommand|null=null;#inflight:GatewayCommandTicket|null=null;
 #sent:bigint|null=null;#received:bigint|null=null;#latency:bigint|null=null;#eventSeen=false;#lastTime=0n;readonly #jitter:(intervalNs:bigint)=>bigint;
 constructor(options:{jitter:(intervalNs:bigint)=>bigint;session?:GatewayResumeSession;resumeUrl?:string}){
  const jitter=options.jitter;if(typeof jitter!=='function'||types.isProxy(jitter)||types.isAsyncFunction(jitter)||types.isGeneratorFunction(jitter))throw new TypeError('Expected synchronous Gateway jitter');this.#jitter=jitter;
  const session=options.session;if(session!==undefined){if(typeof session.id!=='string'||/[\uD800-\uDFFF]/u.test(session.id)||typeof session.sequence!=='bigint'||session.sequence<0n||session.sequence>=(1n<<64n))throw new TypeError('Invalid resume session');this.#session=Object.freeze({id:session.id,sequence:session.sequence});}else this.#session=null;
  if(options.resumeUrl!==undefined&&(typeof options.resumeUrl!=='string'||/[\uD800-\uDFFF]/u.test(options.resumeUrl)))throw new TypeError('Invalid resume URL');this.#resumeUrl=this.#session===null?null:options.resumeUrl??null;
 }
 #time(now:bigint):void{if(typeof now!=='bigint'||now<this.#lastTime)throw new TypeError('Expected monotonic nanoseconds');this.#lastTime=now;}
 #idle():void{if(this.#pending!==null||this.#inflight!==null)throw new TypeError('Gateway control send must finish first');}
 get phase():GatewaySessionPhase{return this.#phase;}
 get identified():boolean{return this.#phase==='Active'||this.#phase==='Resuming';}
 get identifyRequested():boolean{return this.#identify!==null;}
 identifyRequest():GatewayIdentifyTicket|null{return this.#identify;}
 get resumeUrl():string|null{return this.#resumeUrl;}
 resumeSession():GatewayResumeSession|null{return this.#session;}
 heartbeatSchedule():GatewayHeartbeatSchedule|null{return this.#schedule;}
 latencySnapshot(){return Object.freeze({sentAtNs:this.#sent,receivedAtNs:this.#received,lastLatencyNs:this.#latency,eventSeen:this.#eventSeen});}
 connected():void{if(this.#phase!=='Disconnected')throw new TypeError('Gateway is not disconnected');this.#phase='Identifying';}
 #disconnect():void{this.#schedule=null;this.#identify=null;this.#phase='Disconnected';}
 transportFailed():void{this.#idle();if(this.#phase==='FatallyClosed')throw new TypeError('Gateway fatally closed');this.#disconnect();}
 /** Called only when a Gateway-originated close arrives. Our own close's reply
  * cannot reinterpret a disconnected owner as a new fatal close. */
 gatewayClosed(code:number|null):void{this.#idle();if(this.#phase==='FatallyClosed')return;const allowed=gatewayCloseAllowsReconnect(code);if(this.#phase==='Disconnected')return;this.#disconnect();if(!allowed)this.#phase='FatallyClosed';}
 requestClose(code:number):void{this.#idle();if(this.#phase==='FatallyClosed')throw new TypeError('Gateway fatally closed');const retains=gatewayLocalCloseRetainsSession(code);this.#disconnect();if(!retains){this.#session=null;this.#resumeUrl=null;}this.#pending=Object.freeze({kind:'Close',code});}
 takeCommand():GatewayCommandTicket|null{if(this.#inflight!==null)throw new TypeError('Gateway control command already in flight');if(this.#pending===null)return null;const ticket=Object.freeze({command:this.#pending});this.#pending=null;this.#inflight=ticket;return ticket;}
 commandFlushed(ticket:GatewayCommandTicket,now:bigint):void{if(ticket!==this.#inflight)throw new TypeError('Foreign or completed Gateway ticket');this.#time(now);if(ticket.command.kind==='Heartbeat'||ticket.command.kind==='FlushOnly'&&ticket.command.heartbeat){this.#sent=now;this.#received=null;}this.#inflight=null;}
 /** Source Pending retains its flush phase after a send/flush error but has
  * already consumed the payload. Before-payload failure keeps its original data.
  * After-payload failure reconnects with an empty pending record;
  * it must never resend the old authenticated command or heartbeat bytes. */
 commandFailed(ticket:GatewayCommandTicket,stage:'BeforePayload'|'AfterPayload'):void{if(stage!=='BeforePayload'&&stage!=='AfterPayload')throw new TypeError('Expected send failure stage');if(ticket!==this.#inflight)throw new TypeError('Foreign or completed Gateway ticket');this.#inflight=null;this.#pending=stage==='BeforePayload'?ticket.command:Object.freeze({kind:'FlushOnly',heartbeat:ticket.command.kind==='Heartbeat'||ticket.command.kind==='FlushOnly'&&ticket.command.heartbeat});this.#disconnect();}
 identifyGranted(ticket:GatewayIdentifyTicket):boolean{if(ticket!==this.#identify||this.#identify===null)return false;this.#idle();this.#identify=null;this.#pending=Object.freeze({kind:'Identify'});return true;}
 /** Called by the separately owned interval, after pending writes and close
  * commands. Any received packet, not only ACK, prevents the source zombie test. */
 heartbeatTick(): 'Inactive'|'Queued'|'Zombie'{this.#idle();if(this.#schedule===null)return 'Inactive';if(this.#sent!==null&&!this.#eventSeen){this.#disconnect();return 'Zombie';}this.#pending=Object.freeze({kind:'Heartbeat',sequence:this.#session?.sequence??null});this.#eventSeen=false;return 'Queued';}
 processPacket(text:string,now:bigint):GatewaySessionControl{
  this.#idle();if(this.#phase==='FatallyClosed')throw new TypeError('Gateway fatally closed');this.#time(now);const metadata=scanGatewayPacket(text);
  if(this.#sent!==null)this.#eventSeen=true; // Before minimal payload validation.
  const event=decodeGatewaySessionControl(metadata);
  switch(event.kind){
   case 'Ready':this.#session=Object.freeze({id:event.sessionId,sequence:event.sequence});this.#resumeUrl=event.resumeUrl;this.#phase='Active';break;
   case 'Dispatch':if(event.eventType==='RESUMED')this.#phase='Active';if(this.#session!==null)this.#session=Object.freeze({...this.#session,sequence:event.sequence});break;
   case 'Heartbeat':this.#pending=Object.freeze({kind:'Heartbeat',sequence:this.#session?.sequence??null});break;
   case 'HeartbeatAck':if(this.#sent!==null&&this.#received===null){this.#received=now;this.#latency=now-this.#sent;}break;
   case 'Hello':{
    const intervalNs=event.heartbeatIntervalMs*1000000n;if(intervalNs===0n)throw new RangeError('Zero Gateway heartbeat interval');const jitter:unknown=this.#jitter(intervalNs);if(types.isPromise(jitter))void Promise.prototype.then.call(jitter,undefined,()=>undefined);if(typeof jitter!=='bigint'||jitter<0n||jitter>intervalNs)throw new TypeError('Invalid Gateway jitter');
    this.#schedule=Object.freeze({intervalNs,firstAtNs:now+jitter});this.#sent=null;this.#received=null;this.#latency=null;
    if(this.#session!==null){this.#pending=Object.freeze({kind:'Resume',sessionId:this.#session.id,sequence:this.#session.sequence});this.#phase='Resuming';}else this.#identify=Object.freeze({kind:"GatewayIdentifyTicket"});break;
   }
   case 'InvalidSession':this.requestClose(event.resumable?4000:1000);break;
   case 'Reconnect':this.requestClose(4000);break;
   case 'Unhandled':break;
  }
  return event;
 }
}
