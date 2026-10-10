import {isDecodedGatewayInteraction, type DecodedGatewayInteraction} from '../../discord/gateway/decoded-interaction.ts';
import {isRoutedInteractionWork, type RoutedInteractionWork} from '../../discord/interaction-routing.ts';
import {autocompleteResponse, emptyAutocompleteResponse, interactionMessage, isInteractionResponse, type InteractionResponse} from '../../discord/interaction-response.ts';
import {AutocompleteCatalog} from './autocomplete.ts';
type Tag = 'Normal' | 'Busy' | 'Stopping';

/** Source response selection; admission sealing is handled by the dispatcher.
 * Even denied/invalid autocomplete interactions receive an autocomplete response.
 * Busy/stopping replaces a non-autocomplete initial response only when work exists. */
export function interactionDispatchResponse(
  interaction: DecodedGatewayInteraction,
  tag: Tag,
  initial: InteractionResponse,
  work: RoutedInteractionWork | null,
  catalog: AutocompleteCatalog,
): InteractionResponse {
  if (!isDecodedGatewayInteraction(interaction) || !isInteractionResponse(initial)
      || (work !== null && !isRoutedInteractionWork(work))) throw new TypeError('Expected owned interaction route');
  if (tag !== 'Normal' && tag !== 'Busy' && tag !== 'Stopping') throw new TypeError('Expected interaction ingress tag');
  if (interaction.type === 4n) {
    return tag === 'Normal' && work !== null && Object.hasOwn(work, 'Autocomplete')
      ? autocompleteResponse(AutocompleteCatalog.prototype.choices.call(catalog, work))
      : emptyAutocompleteResponse();
  }
  if (work !== null && tag !== 'Normal') {
    return interactionMessage(tag === 'Busy'
      ? 'Codex Discord is busy. Please retry shortly.'
      : 'Codex Discord is stopping. Please retry after restart.', true);
  }
  return initial;
}
