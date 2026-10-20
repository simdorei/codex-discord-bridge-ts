import type {DatabaseSync} from 'node:sqlite';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
import {captureSqliteEvidenceRows} from './sqlite-evidence-rows.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
import {recoverPriorRuntimeIngressIn} from './ingress-recovery.ts';
export interface StartupIngressRecoveryLimits{readonly maxRows:number;readonly maxBytes:number;}
const SELECT="SELECT * FROM discord_ingress_journal WHERE runtime_id IS NOT ? AND owner_id IS NULL AND state IN ('staged','acknowledged','executing','completed') AND confirmation_delivered=0 ORDER BY created_at,ingress_id";
/** Complete bounded preflight in the caller's IMMEDIATE startup transaction.
 * No pagination/partial approval. Bounds include acknowledgement rows, and text
 * is checked before the legacy decoder materializes payload/outcome JSON.
 * Existing native scan/internal allocation bounds and strict TEXT limits remain. */
export function recoverBoundedPriorRuntimeIngressIn(db:DatabaseSync,runtime:string,now:number,limits:StartupIngressRecoveryLimits):number{
 requireDiscordText(runtime);if(runtime.includes('\0')||Buffer.byteLength(runtime)>4096)throw new RangeError('Invalid startup runtime identity');
 if(!Number.isFinite(now)||now<0)throw new RangeError('Invalid startup timestamp');
 const maxRows=own(limits,'maxRows'),maxBytes=own(limits,'maxBytes');
 if(typeof maxRows!=='number'||!Number.isSafeInteger(maxRows)||maxRows<1||maxRows>4096||typeof maxBytes!=='number'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4194304)throw new RangeError('Invalid startup ingress resource limits');
 if(!db.isTransaction)throw new StoreIntegrityError('Startup ingress recovery requires caller transaction');
 const invalid=(reason:string):never=>{throw new StoreIntegrityError('Startup ingress recovery: '+reason);};
 const columns=db.prepare(SELECT).columns();if(columns.length>128||columns.some(c=>Buffer.byteLength(c.name)>4096))invalid('column budget exceeded');
 const captured=captureSqliteEvidenceRows(db,SELECT,[runtime],{bytes:0},{maxRows,maxBytes,reject:invalid}) as {rows:unknown[][]};
 const count=db.prepare("SELECT COUNT(*) AS n FROM (SELECT 1 FROM codex_new_first_replies WHERE confirmation_delivered=0 AND ingress_id IN (SELECT ingress_id FROM discord_ingress_journal WHERE runtime_id IS NOT ?) LIMIT ?)");count.setReadBigInts(true);const n=count.get(runtime,maxRows+1)?.n;
 if(typeof n!=='bigint'||n<0n||n+BigInt(captured.rows.length)>BigInt(maxRows))invalid('complete row budget exceeded');
 return recoverPriorRuntimeIngressIn(db,runtime,now);
}
