import {gatewayOwnField} from '../../discord/gateway/values.ts';
import type {MirrorSyncResult} from './sync.ts';
/** Source MirrorSyncResult Display; no result text is produced on partial failure. */
export function formatMirrorSyncResult(result:MirrorSyncResult):string{
 const count=(key:keyof MirrorSyncResult):number=>{const n=gatewayOwnField(result,key);if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)throw new TypeError('Expected completed mirror count');return n;};
 const limited=gatewayOwnField(result,'limited');if(typeof limited!=='boolean')throw new TypeError('Expected completed mirror mode');
 return `Mirror sync complete.\nprojects: ${count('projects')}\nthreads: ${count('threads')}\nstale_threads_deleted: ${count('archived')}\nunavailable: ${count('unavailable')}\norphan_threads_deleted: ${count('orphanDeleted')}\nprojects_deleted: ${count('projectsDeleted')}\ncleanup: ${limited?'limited sync; existing mappings retained':'obsolete mirror rooms deleted; current mappings protected'}`;
}
