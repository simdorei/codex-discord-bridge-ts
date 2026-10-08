import type {DatabaseSync} from "node:sqlite";
import {types} from "node:util";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {openInitialized,ActiveTransactionError} from "./owned-driver.ts";
import {openExisting} from "./existing-store.ts";
export interface TransactionResult<T>{readonly commit:boolean;readonly value:T}
export const commitStore=<T>(value:T):TransactionResult<T>=>({commit:true,value});
export const rollbackStore=<T>(value:T):TransactionResult<T>=>({commit:false,value});
function call<T>(operation:()=>T):T{
  if(typeof operation!=="function"||types.isProxy(operation)||types.isAsyncFunction(operation)||types.isGeneratorFunction(operation))throw new TypeError("Store scope requires a synchronous operation");const value=operation();if(types.isPromise(value)){void Promise.prototype.then.call(value,undefined,()=>undefined);throw new TypeError("Store operation returned a Promise");}return value;
}
function raise(errors:unknown[]):void{if(errors.length===1)throw errors[0];if(errors.length>1)throw new AggregateError(errors,"Store scope cleanup failed");}
/** Borrows the connection, owns exactly one transaction; never rolls back a caller's
 * existing transaction and never closes the connection. Commit/rollback is explicit. */
export function withStoreTransaction<T>(db:DatabaseSync,mode:"IMMEDIATE"|"DEFERRED",operation:()=>TransactionResult<T>):T{
  if(mode!=="IMMEDIATE"&&mode!=="DEFERRED")throw new TypeError("Invalid transaction mode");if(db.isTransaction)throw new ActiveTransactionError();let began=false,value:T|undefined;const errors:unknown[]=[];
  try{db.exec(`BEGIN ${mode}`);began=true;const result=call(operation);if(result===null||typeof result!=="object"||types.isProxy(result))throw new TypeError("Expected transaction result");const c=Object.getOwnPropertyDescriptor(result,"commit"),v=Object.getOwnPropertyDescriptor(result,"value");if(!c||!Object.hasOwn(c,"value")||typeof c.value!=="boolean"||!v||!Object.hasOwn(v,"value"))throw new TypeError("Expected transaction result data");value=v.value;db.exec(c.value?"COMMIT":"ROLLBACK");began=false;}catch(error){errors.push(error);}
  if(began&&db.isOpen)try{if(db.isTransaction)db.exec("ROLLBACK");}catch(error){errors.push(error);}raise(errors);return value as T;
}
function requireOperation(operation:unknown):void{
  if(typeof operation!=="function"||types.isProxy(operation)||types.isAsyncFunction(operation)||types.isGeneratorFunction(operation))throw new TypeError("Store scope requires a synchronous operation");
}
function runOwned<T>(db:DatabaseSync,operation:(db:DatabaseSync)=>T):T{
  const errors:unknown[]=[];let value:T|undefined;
  try{value=call(()=>operation(db));if(!db.isOpen)throw new StoreIntegrityError("Owned store connection was closed inside its operation");if(db.isTransaction)throw new StoreIntegrityError("Owned store operation left an active transaction");}catch(error){errors.push(error);}try{if(db.isOpen)db.close();}catch(error){errors.push(error);}raise(errors);return value as T;
}
/** Central owned open/close boundary. Connection must not escape the synchronous body. */
export async function usingInitializedStore<T>(path:string,operation:(db:DatabaseSync)=>T):Promise<T>{
  requireOperation(operation);return runOwned(await openInitialized(path),operation);
}
/** Synchronous existing-only scope for preflight/commit paths. Never creates or migrates. */
export function usingExistingStore<T>(path:string,operation:(db:DatabaseSync)=>T):T{
  requireOperation(operation);return runOwned(openExisting(path),operation);
}
