import {decodeGatewayDispatchPayload} from './dispatch-envelope.ts';
import {discordInteractionField} from '../model/interaction.ts';
import {discordReadyField} from '../model/gateway-ready.ts';
import {decodeDiscordInteraction} from '../model/interaction.ts';
import {decodeDiscordReady} from '../model/gateway-ready.ts';
import type {GatewayIdentity} from './identity.ts';
export interface DecodedGatewayInteraction{readonly id:bigint;readonly application_id:bigint;readonly type:bigint;readonly token:string;readonly [key:string]:unknown}
const interactions=new WeakSet<object>();
function freezeOwned(value:unknown):void{if(value===null||typeof value!=='object')return;for(const child of Object.values(value))freezeOwned(child);Object.freeze(value);}
/** Full recognized-field decoding mints immutable Interaction ownership. This does
 * not authenticate a command, send a response, or open a network connection. */
export function decodeGatewayInteraction(text:string):DecodedGatewayInteraction{const result=decodeDiscordInteraction(text);freezeOwned(result);interactions.add(result);return result as unknown as DecodedGatewayInteraction;}
export function isDecodedGatewayInteraction(value:unknown):value is DecodedGatewayInteraction{return value!==null&&typeof value==='object'&&interactions.has(value);}
/** Validate all Ready fields before allowing its identity into sticky runtime state. */
export function decodeGatewayReadyIdentity(text:string):GatewayIdentity{const ready=decodeDiscordReady(text);return Object.freeze({userId:(ready.user as Record<string,unknown>).id as bigint,applicationId:(ready.application as Record<string,unknown>).id as bigint});}

/** Full INTERACTION_CREATE envelope, sharing the parent's Serde context. */
export function decodeGatewayInteractionDispatch(text:string):DecodedGatewayInteraction{const result=decodeGatewayDispatchPayload(text,'INTERACTION_CREATE',discordInteractionField) as Record<string,unknown>;freezeOwned(result);interactions.add(result);return result as unknown as DecodedGatewayInteraction;}
/** Minimal session READY processing alone must never establish runtime identity. */
export function decodeGatewayReadyDispatchIdentity(text:string):GatewayIdentity{const ready=decodeGatewayDispatchPayload(text,'READY',discordReadyField) as Record<string,unknown>;return Object.freeze({userId:(ready.user as Record<string,unknown>).id as bigint,applicationId:(ready.application as Record<string,unknown>).id as bigint});}
