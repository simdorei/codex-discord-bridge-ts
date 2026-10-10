import {types} from 'node:util';
import {GatewaySessionMachine,type GatewayCommandTicket} from './session-machine.ts';
import {GatewayControlEncoder} from './control-encoder.ts';
import {NodeGatewayWebSocket,gatewaySendFailureStage,type GatewaySendFailureStage} from './node-websocket.ts';
export class GatewayControlOwnershipError extends Error{constructor(){super('Gateway command ownership changed or is already sending');this.name='GatewayControlOwnershipError';}}
const executing=new WeakSet<GatewaySessionMachine>();
export type GatewayControlSendResult='TextFlushed'|'FlushOnly'|'CloseRequested';
/** Execute one current command after the caller obtains its rate permit/readiness.
 * Caller exclusively owns the machine across this call (no outside mutation).
 * The same machine cannot send concurrently. No cancellation race abandons a
 * native write: the caller must dispose/join its wire to interrupt it safely.
 * TextFlushed is local transport completion, not server acknowledgement. Close
 * returns protocol-close acceptance; its handshake/drain remains caller-owned. */
export async function sendGatewayControl(options:{machine:GatewaySessionMachine;ticket:GatewayCommandTicket;encoder:GatewayControlEncoder;wire:NodeGatewayWebSocket;nowNs:()=>bigint}):Promise<GatewayControlSendResult>{
 const {machine,ticket,encoder,wire,nowNs}=options;
 if(!machine.isCurrentCommand(ticket)||executing.has(machine))throw new GatewayControlOwnershipError();
 if(typeof nowNs!=='function'||types.isProxy(nowNs)||types.isAsyncFunction(nowNs)||types.isGeneratorFunction(nowNs))throw new TypeError('Expected synchronous Gateway send clock');
 executing.add(machine);let stage:GatewaySendFailureStage='BeforePayload';
 try{
  const encoded=encoder.encode(ticket.command);let result:GatewayControlSendResult;
  if(encoded.kind==='Text'){stage='AfterPayload';await wire.sendText(encoded.payload);result='TextFlushed';}
  else if(encoded.kind==='FlushOnly'){stage='AfterPayload';await wire.flush();result='FlushOnly';}
  else{stage='AfterPayload';wire.requestClose(encoded.code,encoded.reason);result='CloseRequested';}
  if(!machine.isCurrentCommand(ticket))throw new GatewayControlOwnershipError();
  machine.commandFlushed(ticket,nowNs());return result;
 }catch(error){if(machine.isCurrentCommand(ticket))machine.commandFailed(ticket,gatewaySendFailureStage(error)??stage);throw error;}
 finally{executing.delete(machine);}
}
