import {requestObject} from './request-input.ts';
import {parseGatewayAcknowledgement,type GatewayAcknowledgement} from './handshake.ts';
import {parseGatewayCommand,type GatewayCommand} from './gateway-command.ts';
export type GatewayInboundMessage=GatewayAcknowledgement|GatewayCommand;
/** Outer enum's discriminator selects a source-backed decoder. Each branch
 * preserves version preflight before field validation. Large inputs belong in
 * the native gateway adapter; this pure leaf alone is not runtime integration. */
export function parseGatewayInboundMessage(raw:string,maxBytes:number,nowMs=Date.now()):GatewayInboundMessage{
 const v=requestObject(raw,maxBytes),type=Object.hasOwn(v,'type')?v.type:undefined;
 return type==='hello_ack'||type==='project_ack'?parseGatewayAcknowledgement(raw,maxBytes):parseGatewayCommand(raw,maxBytes,nowMs);
}
