import type {DatabaseSync} from 'node:sqlite';
import {validateRecoveryBindingIn,validateIngressRecoveryIn,type RecoveryClaim} from './ingress-recovery-custody.ts';
import {getOwn} from './async-resolution-json-helpers.ts';
import {receiptExists} from './delivery-receipt-key.ts';
import {StoreIntegrityError} from './schema-assembly.ts';
/** Borrowed transaction check. Runtime separately checks Selected identity.
 * No connection lifecycle, mutation, or automatic recovery/retry. */
export function validateRecoveryEffectIn(db:DatabaseSync,binding:unknown,channel:bigint,claim:RecoveryClaim|null):void{
 validateRecoveryBindingIn(db,binding,channel);
 if(getOwn(getOwn(binding,'command'),'Repair')!==undefined&&receiptExists(db,'SELECT EXISTS(SELECT 1 FROM codex_archive_fences WHERE target_thread_id=?) AS held',getOwn(binding,'target') as string))throw new StoreIntegrityError('repair target has an archive fence; original archive intent is preserved; no tool reset was authorized');
 if(claim!==null)validateIngressRecoveryIn(db,claim);
}
