import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {idempotentMessageRequest} from '../../discord/idempotent-message.ts';
import {gatewayOwnField} from '../../discord/gateway/values.ts';
import type {ReadySetupPort,ReadyCommandScope} from './ready-setup.ts';
/** Borrow the actual shared client; no separate client, token or connection pool.
 * Captured owner methods survive caller method replacement. The outer Gateway
 * owner retains close responsibility after all Ready/other consumers settle. */
export function readyHttpPort(client:DiscordChannelClient):ReadySetupPort{
 const brand=Object.getOwnPropertyDescriptor(DiscordChannelClient.prototype,'activeRequests')!.get!;brand.call(client);
 const register=DiscordChannelClient.prototype.registerSlashCommands.bind(client),send=DiscordChannelClient.prototype.sendWithoutReceipt.bind(client);
 return Object.freeze({
  register:(applicationId:bigint,scope:ReadyCommandScope,qa:boolean,signal:AbortSignal)=>{const kind=gatewayOwnField(scope,'kind');if(kind!=='Global'&&kind!=='Guild')throw new TypeError('Expected command scope');const guildId=kind==='Global'?null:gatewayOwnField(scope,'guildId') as bigint;return register(applicationId,guildId,qa,signal);},
  sendNotice:async(channelId:bigint,content:string,domain:string,key:string,chunk:0,signal:AbortSignal)=>{if(chunk!==0)throw new TypeError('Expected startup notice first chunk');await send(idempotentMessageRequest(channelId,content,domain,key,chunk),signal);},
 });
}
