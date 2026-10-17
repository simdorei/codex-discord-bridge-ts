import type {DecodedGatewayInteraction} from './gateway/decoded-interaction.ts';
import {InteractionAccessPolicy} from './interaction-access.ts';
import {routeGatewayCommand,routeGatewayComponent,InteractionRouteError,type InteractionWorkRoute,type RoutedInteractionWork} from './interaction-routing.ts';
import {pongResponse,deferredChannelResponse,deferredInteractionUpdateResponse,emptyAutocompleteResponse,interactionMessage,invalidInteractionMessage,type InteractionResponse} from './interaction-response.ts';
export interface RoutedInteraction{readonly interactionId:bigint;readonly channelId:bigint|null;readonly userId:bigint|null;readonly sourceMessageId:bigint|null;readonly token:string;readonly initialResponse:InteractionResponse;readonly work:RoutedInteractionWork|null}
/** Pure source policy→route→response envelope. Does not acknowledge HTTP, persist
 * admission or execute work. Transport token stays in the returned private-work
 * envelope and is never included in diagnostics or denial response content. */
export function routeInteraction(interaction:DecodedGatewayInteraction,policy:InteractionAccessPolicy,qa:boolean):RoutedInteraction{
 if(typeof qa!=='boolean')throw new TypeError('Expected QA flag');const access=InteractionAccessPolicy.prototype.evaluate.call(policy,interaction);
 const envelope=(initialResponse:InteractionResponse,work:RoutedInteractionWork|null=null):RoutedInteraction=>Object.freeze({interactionId:interaction.id,channelId:access.channelId,userId:access.userId,sourceMessageId:access.sourceMessageId,token:interaction.token,initialResponse,work});
 if(access.kind==='DeniedUser')return envelope(interactionMessage('This Discord user is not allowed to control Codex.',true));
 if(access.kind==='DeniedChannel')return envelope(interactionMessage('This Discord channel is not allowed to control Codex.',true));
 if(interaction.type===1n)return envelope(pongResponse());
 let route:InteractionWorkRoute;try{if(interaction.type===2n||interaction.type===4n)route=routeGatewayCommand(interaction,qa);else if(interaction.type===3n)route=routeGatewayComponent(interaction);else return envelope(invalidInteractionMessage('unsupported or missing interaction data'));}
 catch(error){if(error instanceof InteractionRouteError)return envelope(invalidInteractionMessage(error.message));throw error;}
 const response=route.initialResponse.type===5?deferredChannelResponse():route.initialResponse.type===6?deferredInteractionUpdateResponse():emptyAutocompleteResponse();return envelope(response,route.work);
}
