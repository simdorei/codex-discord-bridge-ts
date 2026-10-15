import type {DatabaseSync} from 'node:sqlite';
import {usingExistingReadOnlyStore,withStoreTransaction,commitStore} from './owned-scope.ts';
import {LATEST_STORE_SCHEMA_VERSION,schemaVersion,schemaExtensionsCurrent,StoreIntegrityError,UnsupportedVersionError} from './schema-assembly.ts';
import {newThreadOriginIn} from './new-thread-origin.ts';
import {pendingNewPromptIn} from './ingress-new-prompt-arm.ts';
import type {SelectedReadBudget} from './selected-read-budget.ts';
function current(db:DatabaseSync):void{
 const found=schemaVersion(db);if(found!==LATEST_STORE_SCHEMA_VERSION)throw new UnsupportedVersionError(found,LATEST_STORE_SCHEMA_VERSION);
 if(!schemaExtensionsCurrent(db))throw new StoreIntegrityError('Message classification requires an initialized current schema; no repair attempted');
}
/** Separate observations, matching the source APIs. No combined snapshot,
 * initialization, migration or SQL duplication. Origin owns its transaction;
 * pending arm retains its one SELECT after catalog compatibility validation. */
export function newThreadOriginExisting(path:string,channel:bigint,budget:SelectedReadBudget){
 return usingExistingReadOnlyStore(path,db=>{current(db);return withStoreTransaction(db,'DEFERRED',()=>commitStore(newThreadOriginIn(db,channel,budget)));});
}
export function pendingNewPromptExisting(path:string,channel:bigint,user:bigint,event:bigint,budget:SelectedReadBudget){
 return usingExistingReadOnlyStore(path,db=>{current(db);return pendingNewPromptIn(db,channel,user,event,budget);});
}
