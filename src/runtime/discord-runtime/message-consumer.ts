import {types} from 'node:util';
import {setImmediate as yieldToRuntime} from 'node:timers/promises';
import type {GatewayIdentity,GatewayIdentityConflict,GatewayStateReceiver} from '../../discord/gateway/identity.ts';
import type {MessageIngress} from '../../discord/gateway/ingress.ts';
import type {IngressLaneReceiver} from '../../discord/gateway/lane.ts';
import {isDecodedGatewayMessage,type DecodedGatewayMessage} from '../../discord/gateway/decoded-message.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import {waitForGatewayIdentity} from './identity-wait.ts';
import {guardGatewayIdentity} from './identity-guard.ts';
import {RuntimeTypedIngressError} from './receive-error-consumer.ts';
export type GatewayMessageHandler=(message:DecodedGatewayMessage,identity:GatewayIdentity,signal:AbortSignal)=>Promise<void>;
/** Same loop serves distinct normal/emergency lane owners. Takes receiver custody,
 * borrows identity subscriptions, and serializes its own handler calls. Business
 * message classification/admission/execution is the mandatory handler boundary,
 * not implemented by this loop. Unlike receive-error lane, shutdown does not drain
 * queued messages: the active operation is cancelled/joined and receiver disposed. */
export async function runMessageConsumer(receiver:IngressLaneReceiver<MessageIngress>,identity:GatewayStateReceiver<GatewayIdentity|null>,conflict:GatewayStateReceiver<GatewayIdentityConflict|null>,shutdown:AbortSignal,force:AbortSignal,handle:GatewayMessageHandler):Promise<void>{
 if(typeof handle!=='function'||types.isProxy(handle)||types.isGeneratorFunction(handle))throw new TypeError('Expected owned message handler');const receive=receiver.receive.bind(receiver),dispose=receiver.dispose.bind(receiver);let count=0;
 try{const established=await waitForGatewayIdentity(identity,conflict,shutdown,force);if(established===null)return;for(;;){
  const next=await guardGatewayIdentity(signal=>receive(signal),conflict,shutdown,force);if(!next.completed)return;if(next.value===null)throw new RuntimeTypedIngressError('Closed','message');
  const message=gatewayOwnField(next.value,'event');if(!isDecodedGatewayMessage(message))throw new TypeError('Expected completely decoded Gateway message');
  const processed=await guardGatewayIdentity(signal=>handle(message,established,signal),conflict,shutdown,force);if(!processed.completed)return;if(++count%64===0)await yieldToRuntime();
 }}finally{dispose();}
}
