import type {DatabaseSync} from "node:sqlite";
import {openInitialized,verifyCurrentCatalogIn} from "./owned-driver.ts";
import {withPromptIntakeWriter,withPromptIntakeWriterExisting} from "./prompt-intake.ts";
import {usingExistingStore,withStoreTransaction,rollbackStore} from "./owned-scope.ts";
import {decodeI64} from "./sqlite-values.ts";
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed claim key");}
function timestamp(value:unknown):asserts value is number{if(typeof value!=="number")throw new TypeError("Expected numeric claim time");}
function checkedExisting<T>(path:string,work:(db:DatabaseSync)=>T):T{return usingExistingStore(path,db=>{withStoreTransaction(db,"DEFERRED",()=>{verifyCurrentCatalogIn(db);return rollbackStore(undefined);});return work(db);});}
async function owned<T>(path:string,work:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return work(db);}finally{db.close();}}
export async function claimComponent(path:string,key:string,now:number,timeToLive:number):Promise<boolean>{
  text(key);timestamp(now);timestamp(timeToLive);
  return withPromptIntakeWriter(path,db=>claimIn(db,key,now,timeToLive),false);
}
function claimIn(db:DatabaseSync,key:string,now:number,timeToLive:number):{value:boolean;commit:true}{
    db.prepare("DELETE FROM persistent_component_claims WHERE expires_at<=?").run(now);
    const changed=db.prepare("INSERT OR IGNORE INTO persistent_component_claims(claim_key,created_at,expires_at) VALUES (?,?,?)").run(key,now,now+timeToLive).changes;
    return {value:BigInt(changed)===1n,commit:true};
}
/** Same cleanup/insert IMMEDIATE transaction, existing catalog only. Cleanup is
 * intentionally unchanged and is not bounded by native envelope limits. */
export function claimComponentExisting(path:string,key:string,now:number,timeToLive:number):boolean{
  text(key);timestamp(now);timestamp(timeToLive);
  return withPromptIntakeWriterExisting(path,db=>claimIn(db,key,now,timeToLive));
}
function releaseIn(db:DatabaseSync,key:string):boolean{return BigInt(db.prepare("DELETE FROM persistent_component_claims WHERE claim_key=?").run(key).changes)===1n;}
export async function releaseComponentClaim(path:string,key:string):Promise<boolean>{text(key);return owned(path,db=>releaseIn(db,key));}
/** Preserve the original single-statement autocommit release. */
export function releaseComponentClaimExisting(path:string,key:string):boolean{text(key);return checkedExisting(path,db=>releaseIn(db,key));}
export async function cleanupComponentClaims(path:string,now:number):Promise<bigint>{timestamp(now);return owned(path,db=>BigInt(db.prepare("DELETE FROM persistent_component_claims WHERE expires_at<=?").run(now).changes));}
export async function componentClaimCounts(path:string,now:number):Promise<readonly [bigint,bigint]>{
  timestamp(now);return owned(path,db=>{const count=(op:string)=>{const s=db.prepare(`SELECT COUNT(*) AS n FROM persistent_component_claims WHERE expires_at${op}?`);s.setReadBigInts(true);return decodeI64(s.get(now)?.n,"count");};return [count(">"),count("<=")];});
}

/** Source runtime confirmation_ready query centralized with claim storage. */
export function isComponentClaimLive(path:string,key:string,now:number):Promise<boolean>{
  text(key);timestamp(now);return owned(path,db=>liveIn(db,key,now));
}
function liveIn(db:DatabaseSync,key:string,now:number):boolean{
    const statement=db.prepare("SELECT EXISTS(SELECT 1 FROM persistent_component_claims WHERE claim_key=? AND expires_at>?) AS live");
    statement.setReadBigInts(true);return decodeI64(statement.get(key,now)?.live,"live")!==0n;
}
/** A separate source read, never combined with the claim transaction. */
export function isComponentClaimLiveExisting(path:string,key:string,now:number):boolean{text(key);timestamp(now);return checkedExisting(path,db=>liveIn(db,key,now));}
