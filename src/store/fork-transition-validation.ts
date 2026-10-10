import type {DatabaseSync} from "node:sqlite";
import {decodeI64,decodeTimestamp,decodeTextField,textDecoderFor} from "./sqlite-values.ts";
import {trimUnicodeWhitespace as trim} from "./queue-preflight-failure.ts";
export type ForkTransitionFailure=
  |{kind:"InvalidIdentity"}
  |{kind:"StaleStartingJob"|"StartingAttemptLeaseActive";jobId:string}
  |{kind:"MissingOrStaleMapping"|"AdditionalInFlight";sourceThreadId:string}
  |{kind:"TargetConflict";targetThreadId:string}
  |{kind:"ForkTargetNotObserved";handoffId:string};
function message(f:ForkTransitionFailure):string{
  switch(f.kind){
    case "InvalidIdentity":return "invalid app-server fork handoff identity";
    case "StaleStartingJob":return `ambiguous starting job changed before fork handoff: ${f.jobId}`;
    case "StartingAttemptLeaseActive":return `starting attempt lease is still active: ${f.jobId}`;
    case "MissingOrStaleMapping":return `mirror mapping is missing, stale, or duplicated for ${f.sourceThreadId}`;
    case "AdditionalInFlight":return `source has another starting or running queue job: ${f.sourceThreadId}`;
    case "TargetConflict":return `fork target is already in use: ${f.targetThreadId}`;
    case "ForkTargetNotObserved":return `fork target has not been durably observed for handoff ${f.handoffId}`;
  }
}
export class ForkTransitionError extends Error{
  readonly kind:ForkTransitionFailure["kind"];readonly failure:ForkTransitionFailure;
  constructor(failure:ForkTransitionFailure){super(message(failure));this.name="ForkTransitionError";this.kind=failure.kind;this.failure=Object.freeze({...failure});}
}
export function validateForkStartingIn(db:DatabaseSync,jobId:string|null,source:string,generation:bigint,leaseNow:number|null):void{
  if(jobId===null)return;
  const stmt=db.prepare(`SELECT updated_at,last_error,CAST(last_error AS BLOB) AS raw,(SELECT encoding FROM pragma_encoding) AS encoding
    FROM codex_turn_queue WHERE job_id=? AND target_thread_id=? AND app_server_generation=? AND state='starting' AND turn_id IS NULL`);stmt.setReadBigInts(true);
  const row=stmt.get(jobId,source,generation);if(row===undefined)throw new ForkTransitionError({kind:"StaleStartingJob",jobId});
  const updated=decodeTimestamp(row.updated_at,"updated_at"),error=decodeTextField(row.last_error,row.raw,"last_error",false,textDecoderFor(row.encoding))!;
  if(leaseNow!==null&&trim(error)===""&&updated>leaseNow-120)throw new ForkTransitionError({kind:"StartingAttemptLeaseActive",jobId});
}
export function validateForkNoOtherInflightIn(db:DatabaseSync,source:string,excluded:string|null):void{
  const stmt=db.prepare("SELECT COUNT(*) AS n FROM codex_turn_queue WHERE target_thread_id=? AND state IN ('starting','running') AND (? IS NULL OR job_id!=?)");stmt.setReadBigInts(true);
  if(decodeI64(stmt.get(source,excluded,excluded)?.n,"inflight count")!==0n)throw new ForkTransitionError({kind:"AdditionalInFlight",sourceThreadId:source});
}
export function forkMappingSnapshotIn(db:DatabaseSync,source:string):readonly [bigint,bigint]{
  const stmt=db.prepare("SELECT discord_channel_id,discord_thread_id FROM mirror_threads WHERE codex_thread_id=?");stmt.setReadBigInts(true);const row=stmt.get(source);
  if(row===undefined)return [0n,0n];const channel=decodeI64(row.discord_channel_id,"discord_channel_id"),thread=decodeI64(row.discord_thread_id,"discord_thread_id");
  const bad=()=>new ForkTransitionError({kind:"MissingOrStaleMapping",sourceThreadId:source});if(channel===0n&&thread===0n)throw bad();
  const count=db.prepare("SELECT COUNT(*) AS n FROM mirror_threads WHERE discord_thread_id=?");count.setReadBigInts(true);
  if(decodeI64(count.get(thread)?.n,"mapping count")!==1n)throw bad();return [channel,thread];
}
