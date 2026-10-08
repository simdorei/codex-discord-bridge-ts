import type {DatabaseSync} from "node:sqlite";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {decodeBool,decodeI64} from "./sqlite-values.ts";
import {commitStore,rollbackStore,withStoreTransaction,usingInitializedStore,usingExistingStore} from "./owned-scope.ts";
import {type ObservationScope,type ObservationGap,scope,integer,text,I64_MAX,active,scalar,GAP_COLUMNS,readGapRow,gapComplete,requiredTransaction} from "./observation-gap-model.ts";
export type {ObservationScope,ObservationGap} from "./observation-gap-model.ts";
export function activateObservationOn(db:DatabaseSync,input:ObservationScope):void{
  const s=scope(input);if(s.ownerId===""||s.generation<0n)throw new StoreIntegrityError("invalid observation scope");
  return withStoreTransaction(db,"IMMEDIATE",()=>{
    const q=db.prepare("SELECT active FROM cdr_observation_streams WHERE owner_id=?1 AND generation=?2");q.setReadBigInts(true);const existing=q.get(s.ownerId,s.generation);
    if(existing!==undefined){if(!decodeBool(existing.active,"active"))throw new StoreIntegrityError("retired observation scope cannot reactivate");return commitStore(undefined);}
    const counts=db.prepare("SELECT COUNT(*) AS count,COALESCE(SUM(active),0) AS active_count,COALESCE(MAX(generation),-1) AS maximum FROM cdr_observation_streams WHERE owner_id=?1");counts.setReadBigInts(true);const r=counts.get(s.ownerId)!;
    const count=decodeI64(r.count,"count"),activeCount=decodeI64(r.active_count,"active_count"),maximum=decodeI64(r.maximum,"maximum");
    if(count>0n&&(activeCount===0n||s.generation<=maximum))throw new StoreIntegrityError("retired owner or stale observation generation");
    db.prepare(`INSERT OR IGNORE INTO cdr_observation_gaps
      (owner_id,generation,first_seq,last_seq,scan_cursor,state,detail)
      SELECT owner_id,generation,0,0,0,'Unresolved','previous unsealed stream; missing tail is not reconstructed'
      FROM cdr_observation_streams WHERE unsealed=1 AND (owner_id!=?1 OR generation!=?2)`).run(s.ownerId,s.generation);
    if(scalar(db,`SELECT EXISTS(SELECT 1 FROM cdr_observation_streams s
      WHERE s.unsealed=1 AND (s.owner_id!=?1 OR s.generation!=?2)
      AND NOT EXISTS(SELECT 1 FROM cdr_observation_gaps g WHERE g.owner_id=s.owner_id AND g.generation=s.generation
        AND g.first_seq=0 AND g.last_seq=0 AND g.state='Unresolved')) AS n`,s.ownerId,s.generation)!==0n)throw new StoreIntegrityError("previous unsealed observation tail was not preserved");
    db.prepare("UPDATE cdr_observation_streams SET active=0 WHERE owner_id!=?1 OR generation!=?2").run(s.ownerId,s.generation);
    db.prepare(`INSERT INTO cdr_observation_streams(owner_id,generation,active) VALUES(?1,?2,1)
      ON CONFLICT(owner_id,generation) DO UPDATE SET active=1`).run(s.ownerId,s.generation);return commitStore(undefined);
  });
}
export function discoverObservationOn(db:DatabaseSync,input:ObservationScope,upper:bigint):void{
  const s=scope(input);integer(upper);if(upper<0n||upper>=I64_MAX)throw new StoreIntegrityError("source sequence exhausted");
  return withStoreTransaction(db,"IMMEDIATE",()=>{
    if(!active(db,s))throw new StoreIntegrityError("observation scope is not active");const seen=scalar(db,"SELECT seen_seq AS n FROM cdr_observation_streams WHERE owner_id=?1 AND generation=?2",s.ownerId,s.generation);
    if(upper<=seen)return commitStore(undefined);
    const insert=db.prepare(`INSERT INTO cdr_observation_gaps(owner_id,generation,first_seq,last_seq,scan_cursor,state) VALUES(?1,?2,?3,?4,?5,'Open')`);insert.setReadBigInts(true);const result=insert.run(s.ownerId,s.generation,seen+1n,upper,seen);
    if(BigInt(result.changes)!==1n)throw new StoreIntegrityError("observation range was not inserted");const id=decodeI64(result.lastInsertRowid,"last_insert_rowid");
    const advanced=db.prepare("UPDATE cdr_observation_streams SET seen_seq=?3 WHERE owner_id=?1 AND generation=?2 AND active=1 AND seen_seq=?4").run(s.ownerId,s.generation,upper,seen).changes;
    if(BigInt(advanced)!==1n)throw new StoreIntegrityError("observation checkpoint CAS lost");
    if(scalar(db,`SELECT EXISTS(SELECT 1 FROM cdr_observation_gaps g
      JOIN cdr_observation_streams s ON s.owner_id=g.owner_id AND s.generation=g.generation
      WHERE g.gap_id=?1 AND g.owner_id=?2 AND g.generation=?3 AND g.first_seq=?4 AND g.last_seq=?5 AND g.scan_cursor=?6
      AND g.revision=0 AND g.state='Open' AND g.verified_json='[]' AND s.active=1 AND s.seen_seq=?5) AS n`,id,s.ownerId,s.generation,seen+1n,upper,seen)===0n)throw new StoreIntegrityError("observation range/checkpoint identity was not preserved");
    return commitStore(undefined);
  });
}
export function markUnknownObservationOn(db:DatabaseSync,input:ObservationScope,detail:string):void{
  const s=scope(input);text(detail);const bounded=Array.from(detail).slice(0,512).join("");return withStoreTransaction(db,"IMMEDIATE",()=>{
    db.prepare(`INSERT OR IGNORE INTO cdr_observation_gaps(owner_id,generation,first_seq,last_seq,scan_cursor,state,detail) VALUES(?1,?2,0,0,0,'Unresolved',?3)`).run(s.ownerId,s.generation,bounded);
    if(scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_observation_gaps WHERE owner_id=?1 AND generation=?2 AND first_seq=0 AND last_seq=0 AND state='Unresolved') AS n",s.ownerId,s.generation)===0n)throw new StoreIntegrityError("unattributed observation gap was not preserved");return commitStore(undefined);
  });
}
export function nextObservationGapOn(db:DatabaseSync,input:ObservationScope):ObservationGap|null{
  const s=scope(input);return withStoreTransaction(db,"IMMEDIATE",()=>{
    if(!active(db,s))return rollbackStore(null);
    const q=db.prepare("SELECT scan_after,cycle_upper FROM cdr_observation_streams WHERE owner_id=?1 AND generation=?2");q.setReadBigInts(true);const row=q.get(s.ownerId,s.generation)!;let after=decodeI64(row.scan_after,"scan_after"),upper=decodeI64(row.cycle_upper,"cycle_upper"),found:ObservationGap|null=null;
    for(let i=0;i<2;i++){
      const select=db.prepare(`SELECT ${GAP_COLUMNS} FROM cdr_observation_gaps WHERE owner_id=?1 AND generation=?2 AND state='Open' AND first_seq>0 AND gap_id>?3 AND gap_id<=?4 ORDER BY gap_id LIMIT 1`);select.setReadBigInts(true);const r=select.get(s.ownerId,s.generation,after,upper);if(r!==undefined){found=readGapRow(r);break;}
      after=0n;upper=scalar(db,"SELECT COALESCE(MAX(gap_id),0) AS n FROM cdr_observation_gaps WHERE owner_id=?1 AND generation=?2",s.ownerId,s.generation);
    }
    db.prepare("UPDATE cdr_observation_streams SET scan_after=?3,cycle_upper=?4 WHERE owner_id=?1 AND generation=?2").run(s.ownerId,s.generation,after,upper);
    if(found!==null&&found.cursor===found.last){const revision=decodeI64(found.revision+1n,"observation revision");db.prepare("UPDATE cdr_observation_gaps SET scan_cursor=first_seq-1,revision=revision+1 WHERE gap_id=?").run(found.id);found=Object.freeze({...found,cursor:found.first-1n,revision});}
    return commitStore(found);
  });
}
/** Caller owns one consistent read transaction; no target-local coverage exception. */
export function observationScopeVerifiedIn(db:DatabaseSync,input:ObservationScope,through:bigint):boolean{
  requiredTransaction(db);const s=scope(input);integer(through);const query=db.prepare("SELECT seen_seq FROM cdr_observation_streams WHERE owner_id=?1 AND generation=?2 AND active=1");query.setReadBigInts(true);const row=query.get(s.ownerId,s.generation);if(row===undefined)return false;const seen=decodeI64(row.seen_seq,"seen_seq");
  if(through<0n||through>seen||seen<0n||seen>=I64_MAX)return false;
  if(scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_observation_streams WHERE unsealed=1 AND (owner_id!=?1 OR generation!=?2)) AS n",s.ownerId,s.generation)!==0n)return false;
  if(scalar(db,"SELECT EXISTS(SELECT 1 FROM cdr_observation_gaps WHERE state!='Verified') AS n")!==0n)return false;
  const gaps=db.prepare(`SELECT ${GAP_COLUMNS} FROM cdr_observation_gaps WHERE owner_id=?1 AND generation=?2 AND first_seq>0 AND state='Verified' ORDER BY first_seq,gap_id`);gaps.setReadBigInts(true);let expected=1n;
  for(const row of gaps.iterate(s.ownerId,s.generation)){const gap=readGapRow(row);if(gap.first!==expected||gap.last>seen||!gapComplete(gap))return false;expected=gap.last+1n;}
  return expected===seen+1n;
}
export function observationScopeVerifiedOn(db:DatabaseSync,input:ObservationScope,through:bigint):boolean{return withStoreTransaction(db,"DEFERRED",()=>commitStore(observationScopeVerifiedIn(db,input,through)));}
export function activateObservation(path:string,input:ObservationScope):Promise<void>{const s=scope(input);return usingInitializedStore(path,db=>activateObservationOn(db,s));}
export function discoverObservation(path:string,input:ObservationScope,upper:bigint):Promise<void>{const s=scope(input);integer(upper);return usingInitializedStore(path,db=>discoverObservationOn(db,s,upper));}
export function markUnknownObservation(path:string,input:ObservationScope,detail:string):Promise<void>{const s=scope(input);text(detail);return usingInitializedStore(path,db=>markUnknownObservationOn(db,s,detail));}
export function nextObservationGap(path:string,input:ObservationScope):Promise<ObservationGap|null>{const s=scope(input);return usingInitializedStore(path,db=>nextObservationGapOn(db,s));}
export function observationScopeVerified(path:string,input:ObservationScope,through:bigint):Promise<boolean>{const s=scope(input);integer(through);return usingInitializedStore(path,db=>observationScopeVerifiedOn(db,s,through));}

// Existing-only runtime adapters: startup establishes schema before synchronous callbacks.
export function activateObservationExisting(path:string,input:ObservationScope):void{const s=scope(input);usingExistingStore(path,db=>activateObservationOn(db,s));}
export function discoverObservationExisting(path:string,input:ObservationScope,upper:bigint):void{const s=scope(input);integer(upper);usingExistingStore(path,db=>discoverObservationOn(db,s,upper));}
export function markUnknownObservationExisting(path:string,input:ObservationScope,detail:string):void{const s=scope(input);text(detail);usingExistingStore(path,db=>markUnknownObservationOn(db,s,detail));}
export function observationScopeVerifiedExisting(path:string,input:ObservationScope,through:bigint):boolean{const s=scope(input);integer(through);return usingExistingStore(path,db=>observationScopeVerifiedOn(db,s,through));}
