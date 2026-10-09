import {types} from 'node:util';
import {serializeDiscordComponent, type DiscordComponent} from './components.ts';
import {gatewayOwnField} from './gateway/values.ts';
import {isSupportedInteractionToken} from './interaction-callback-request.ts';
import {requireDiscordText} from './text.ts';
/** Same restricted opaque-token profile as callbacks; never accepts arbitrary URLs. */
export function originalInteractionResponseResource(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const match = /^webhooks\/([1-9][0-9]{0,19})\/([^/]+)\/messages\/@original$/u.exec(path);
  if (match === null || match[0] !== path || BigInt(match[1]!) >= 1n << 64n || !isSupportedInteractionToken(match[2])) return null;
  return `webhooks/${match[1]}/${match[2]}`;
}
export function isOriginalInteractionResponsePath(path: unknown): path is string {return originalInteractionResponseResource(path) !== null;}
/** Source update_initial_response with no components. Empty/whitespace content
 * is allowed; twilight_validate counts Unicode scalar values, not UTF-16 units.
 * No attachments/components field is emitted, so existing values are preserved. */
export function interactionUpdateRequest(applicationId: bigint, token: string, content: string) {
  return interactionUpdateRequestWithComponents(applicationId, token, content, []);
}
/** Only helper-owned component DTOs. Empty arrays are omitted, matching source,
 * and do not clear the existing UI. No attachments/general multipart profile. */
export function interactionUpdateRequestWithComponents(applicationId: bigint, token: string, content: string, components: readonly DiscordComponent[]) {
  if (typeof applicationId !== 'bigint' || applicationId <= 0n || applicationId >= 1n << 64n || !isSupportedInteractionToken(token)) throw new TypeError('Unsupported interaction update identity/token profile');
  requireDiscordText(content); let length = 0; for (const _ of content) length++;
  if (length > 2000) throw new RangeError('Discord interaction update content exceeds 2000 characters');
  if (!Array.isArray(components) || types.isProxy(components)) throw new TypeError('Expected owned component list');
  const encoded: string[] = [];
  for (let i = 0; i < components.length; i++) encoded.push(serializeDiscordComponent(gatewayOwnField(components, String(i)) as DiscordComponent));
  return Object.freeze({method: 'PATCH' as const, path: `webhooks/${applicationId}/${token}/messages/@original`,
    body: `{"allowed_mentions":{"parse":[]}${encoded.length ? `,"components":[${encoded.join(",")}]` : ""},"content":${JSON.stringify(content)}}`, authorization: null});
}
