import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {withPromptIntakeWriter} from "./prompt-intake.ts";
import {decodeI64} from "./sqlite-values.ts";
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed claim key");}
function timestamp(value:unknown):asserts value is number{if(typeof value!=="number")throw new TypeError("Expected numeric claim time");}
async function owned<T>(path:string,work:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return work(db);}finally{db.close();}}
export async function claimComponent(path:string,key:string,now:number,timeToLive:number):Promise<boolean>{
  text(key);timestamp(now);timestamp(timeToLive);
  return withPromptIntakeWriter(path,db=>{
    db.prepare("DELETE FROM persistent_component_claims WHERE expires_at<=?").run(now);
    const changed=db.prepare("INSERT OR IGNORE INTO persistent_component_claims(claim_key,created_at,expires_at) VALUES (?,?,?)").run(key,now,now+timeToLive).changes;
    return {value:BigInt(changed)===1n,commit:true};
  },false);
}
export async function releaseComponentClaim(path:string,key:string):Promise<boolean>{text(key);return owned(path,db=>BigInt(db.prepare("DELETE FROM persistent_component_claims WHERE claim_key=?").run(key).changes)===1n);}
export async function cleanupComponentClaims(path:string,now:number):Promise<bigint>{timestamp(now);return owned(path,db=>BigInt(db.prepare("DELETE FROM persistent_component_claims WHERE expires_at<=?").run(now).changes));}
export async function componentClaimCounts(path:string,now:number):Promise<readonly [bigint,bigint]>{
  timestamp(now);return owned(path,db=>{const count=(op:string)=>{const s=db.prepare(`SELECT COUNT(*) AS n FROM persistent_component_claims WHERE expires_at${op}?`);s.setReadBigInts(true);return decodeI64(s.get(now)?.n,"count");};return [count(">"),count("<=")];});
}
