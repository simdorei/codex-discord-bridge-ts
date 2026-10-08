import type {DatabaseSync} from "node:sqlite";
import {usingExistingStore} from "./owned-scope.ts";
import {targetIsHeldIn,generationIsSealedIn} from "./dead-generation-admission.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeBool} from "./sqlite-values.ts";
function target(value:string):void{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed target");}
function stopHeld(db:DatabaseSync,value:string):boolean{target(value);const q=db.prepare("SELECT EXISTS(SELECT 1 FROM cdr_stop_controls WHERE target_thread_id=? AND phase<>'settled') AS held");q.setReadBigInts(true);return decodeBool(q.get(value)?.held,"stop control hold");}
export function requireStopControlUnheldIn(db:DatabaseSync,value:string):void{if(stopHeld(db,value))throw new StoreIntegrityError("original stop control authority differs; no interrupt or replay");}
export function stopControlTargetHeldExisting(path:string,value:string):boolean{return usingExistingStore(path,db=>{db.exec("PRAGMA busy_timeout=500");return stopHeld(db,value);});}
/** Initialized-store runtime contract. These never migrate/repair an absent or replaced
 * database, unlike Rust's open_initialized wrapper; startup must establish the schema. */
export function deadGenerationTargetHeldExisting(path:string,value:string):boolean{return usingExistingStore(path,db=>targetIsHeldIn(db,value));}
export function deadGenerationSealedExisting(path:string,generation:bigint):boolean{return usingExistingStore(path,db=>generationIsSealedIn(db,generation));}
