import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {listModels} from '../../app-server/requests.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {AutocompleteCatalog} from '../discord-dispatch/autocomplete.ts';
/** Source model/list bootstrap with the captured native generation. RPC failure
 * is fatal to this observation, not an empty-catalog fallback. Parsing reuses the
 * current bounded-transport JSON/catalog path; this does not claim worker offload
 * or register Discord commands. Caller owns the resident and its cleanup. */
export async function loadRuntimeAutocomplete(server:PortableResidentLifecycle,signal?:AbortSignal):Promise<AutocompleteCatalog>{
 signal?.throwIfAborted();const generation=PortableResidentLifecycle.prototype.generation.call(server);
 const result=await PortableResidentLifecycle.prototype.execute.call(server,listModels(),generation,signal);
 signal?.throwIfAborted();return new AutocompleteCatalog(serializeSerdeValue(result));
}
