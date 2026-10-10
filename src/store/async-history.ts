import {createHash} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "./owned-driver.ts";
import {readAsyncObligationsIn,type AsyncObligation} from "./async-resolution-records.ts";
import {originalHistoricalQuestion} from "./async-history-question.ts";
import {answerPrompt,ANSWER_PREFIX,type SealedQuestion} from "./async-question-body.ts";
import {AsyncResolutionHeldError} from "./async-resolution-admission.ts";
import {getOwn} from "./async-resolution-json-helpers.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
import {decodeI64,decodeTextField,textDecoderFor} from "./sqlite-values.ts";

export interface HistorySnapshot {turnIds():readonly string[];obligationCount():number}
interface SnapshotData {thread:string;rows:AsyncObligation[];mapping:[string,bigint][]}
const snapshots=new WeakMap<HistorySnapshot,SnapshotData>();
const utf8Sort=(a:string,b:string):number=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const hash=(text:string):string=>createHash("sha256").update(text).digest("hex");
function fail(thread:string,reason:string):never{throw new AsyncResolutionHeldError(thread,reason);}
function snapshotIn(db:DatabaseSync,thread:string):SnapshotData {
  const rows=readAsyncObligationsIn(db,thread);
  const query=db.prepare(`SELECT codex_thread_id,CAST(codex_thread_id AS BLOB) AS thread_raw,discord_thread_id,
    (SELECT encoding FROM pragma_encoding) AS encoding FROM mirror_threads WHERE codex_thread_id=?1 OR discord_thread_id IN
    (SELECT channel_id FROM cdr_async_execution_obligations WHERE thread_id=?1) ORDER BY codex_thread_id,discord_thread_id`);
  query.setReadBigInts(true);const mapping:[string,bigint][]=[];
  for(const row of query.iterate(thread)) mapping.push([
    decodeTextField(row.codex_thread_id,row.thread_raw,"codex_thread_id",false,textDecoderFor(row.encoding))!,
    decodeI64(row.discord_thread_id,"discord_thread_id")]);
  return {thread,rows,mapping};
}
export async function captureAsyncHistorySnapshot(path:string,thread:string):Promise<HistorySnapshot|null> {
  const db=await openInitialized(path);
  try {
    db.exec("BEGIN");const data=snapshotIn(db,thread);
    if(data.rows.length===0)return null;
    for(const row of data.rows)originalHistoricalQuestion(row);
    const snapshot:HistorySnapshot=Object.freeze({turnIds:()=>[...new Set(data.rows.map(r=>r.turn_id))].sort(utf8Sort),obligationCount:()=>data.rows.length});
    snapshots.set(snapshot,data);return snapshot;
  }finally{if(db.isTransaction)db.exec("ROLLBACK");db.close();}
}
const PUBLIC_FIELDS=["question_id","thread_id","origin_job_id","turn_id","version","revision","answer_state","execution_state","admission_state","policy","claim_sha256","original_error"] as const;
function fingerprint(snapshot:SnapshotData):string {
  const rows=snapshot.rows.map(row=>"{"+PUBLIC_FIELDS.map(k=>JSON.stringify(k)+":"+serializeSerdeValue(row[k])).join(",")+"}");
  return "[["+rows.join(",")+"],"+serializeSerdeValue(snapshot.mapping)+"]";
}
function exactInput(turn:unknown,q:SealedQuestion):readonly [unknown,boolean] {
  const items=getOwn(turn,"items");
  if(!Array.isArray(items)||items.length>1024)fail(q.thread_id,"historical turn items are missing or exceed the bound");
  const ids=new Set<string>();
  for(const item of items){const id=getOwn(item,"id");if(typeof id==="string"&&id!==""){if(ids.has(id))fail(q.thread_id,"historical item identity is duplicated");ids.add(id);}}
  const prompt=answerPrompt(q,q.chosen);let matched:unknown=null,conflict=false;
  for(const item of items){
    if(getOwn(item,"type")!=="userMessage")continue;
    const content=getOwn(item,"content");if(!Array.isArray(content)||content.length!==1||getOwn(content[0],"type")!=="text")continue;
    const text=getOwn(content[0],"text");if(typeof text!=="string")continue;
    if(text===prompt){
      const id=getOwn(item,"id");if(typeof id!=="string"||id===""||Buffer.byteLength(id)>512)fail(q.thread_id,"historical accepted input identity is missing");
      if(matched!==null)conflict=true;matched=item;
    }else{
      const newline=text.indexOf("\n");if(newline<0||text.slice(0,newline)!==ANSWER_PREFIX)continue;
      let other:unknown;try{other=parseSerdeValue(text.slice(newline+1));}catch{continue;}
      if(getOwn(other,"thread_id")===q.thread_id&&getOwn(other,"original_turn_id")===q.turn_id&&getOwn(other,"question_item_id")===q.item_id&&getOwn(other,"question_index")===q.body.index)conflict=true;
    }
  }
  return [conflict?null:matched,conflict];
}
function candidate(row:AsyncObligation,turn:unknown,historyHash:string,observer:string,generation:bigint):Record<string,unknown>{
  const q=originalHistoricalQuestion(row),[input,conflict]=exactInput(turn,q),status=getOwn(turn,"status");
  if(status!=="completed"&&status!=="failed"&&status!=="interrupted"&&status!=="inProgress")fail(q.thread_id,"historical original turn status is not typed");
  const terminal=status==="inProgress"?null:status;
  const facts={question_id:row.question_id,revision:row.revision,claim_sha256:row.claim_sha256,thread_id:row.thread_id,
    original_turn_id:row.turn_id,input,answer_conflict:conflict,terminal_status:terminal};
  return {version:1n,source:"historical_read_candidate_v1",observer,generation,question_id:row.question_id,revision:row.revision,
    claim_sha256:row.claim_sha256,thread_id:row.thread_id,original_turn_id:row.turn_id,history_sha256:historyHash,
    original_turn_sha256:hash(serializeSerdeValue(turn)),answer_input_id:getOwn(input,"id")??null,matching_input:input,
    answer_conflict:conflict,terminal_status:terminal,review_key:hash(serializeSerdeValue(facts)),execution_authority:false};
}
function semanticFacts(evidence:unknown):unknown {
  const v=(key:string)=>getOwn(evidence,key)??null;
  return {question_id:v("question_id"),revision:v("revision"),claim_sha256:v("claim_sha256"),thread_id:v("thread_id"),
    original_turn_id:v("original_turn_id"),input:v("matching_input"),answer_conflict:v("answer_conflict"),terminal_status:v("terminal_status")};
}

import {retainAsyncTerminalCandidateIn} from "./async-resolution-terminal.ts";
import {asI64} from "./async-resolution-json-helpers.ts";
import {trimUnicodeWhitespace as trim} from "./queue-preflight-failure.ts";
const isDigest=(v:unknown):boolean=>typeof v==="string"&&/^[0-9a-fA-F]{64}$/.test(v);
function validCandidateIn(db:DatabaseSync,row:AsyncObligation,key:string,expected:Record<string,unknown>):boolean {
  const invalid=():never=>fail(row.thread_id,"stored historical candidate does not preserve the exact verified answer facts");
  const query=db.prepare(`SELECT evidence_sha256,CAST(evidence_sha256 AS BLOB) AS digest_raw,
    CASE WHEN length(CAST(evidence_text AS BLOB))<=131072 THEN evidence_text END AS evidence,
    CAST(CASE WHEN length(CAST(evidence_text AS BLOB))<=131072 THEN evidence_text END AS BLOB) AS evidence_raw,
    (SELECT encoding FROM pragma_encoding) AS encoding FROM cdr_async_terminal_candidates
    WHERE question_id=? AND revision=? AND kind='unverified'
      AND CASE WHEN json_valid(evidence_text) THEN json_extract(evidence_text,'$.review_key') END=? LIMIT 9`);
  query.setReadBigInts(true);const rows:[string,string|null][]=[];
  for(const value of query.iterate(row.question_id,row.revision,key)) {
    const decoder=textDecoderFor(value.encoding);
    rows.push([decodeTextField(value.evidence_sha256,value.digest_raw,"evidence_sha256",false,decoder)!,
      decodeTextField(value.evidence,value.evidence_raw,"evidence",true,decoder)]);
  }
  if(rows.length>8)invalid();
  for(const [digest,raw] of rows){
    if(raw===null||hash(raw)!==digest)invalid();
    let stored:unknown;try{stored=parseSerdeValue(raw!);}catch{invalid();}
    const observer=getOwn(stored,"observer"),generation=asI64(getOwn(stored,"generation"));
    if(getOwn(stored,"version")!==1n||getOwn(stored,"source")!=="historical_read_candidate_v1"||getOwn(stored,"execution_authority")!==false||
      typeof observer!=="string"||trim(observer)===""||Buffer.byteLength(observer)>256||generation===undefined||generation<0n||
      !isDigest(getOwn(stored,"history_sha256"))||!isDigest(getOwn(stored,"original_turn_sha256"))||
      getOwn(stored,"matching_input")===undefined||getOwn(stored,"terminal_status")===undefined||
      !serdeValueEqual(getOwn(stored,"answer_input_id"),getOwn(expected,"answer_input_id"))||
      !serdeValueEqual(semanticFacts(stored),semanticFacts(expected))||hash(serializeSerdeValue(semanticFacts(stored)))!==key)invalid();
  }
  return rows.length!==0;
}
/** Preserve candidate provenance and answer receipt; never settles logical execution. */
export async function retainAsyncHistoryCandidate(path:string,expected:HistorySnapshot,history:unknown,observer:string,generation:bigint):Promise<number>{
  const snapshot=snapshots.get(expected);if(!snapshot)throw new TypeError("Expected a captured history snapshot");
  const encoded=serializeSerdeValue(history);
  // Caller cannot mutate evidence across the database-open await.
  const owned:unknown=structuredClone(history);
  if(Buffer.byteLength(encoded)>1048576||typeof observer!=="string"||observer===""||Buffer.byteLength(observer)>256||
    typeof generation!=="bigint"||generation<0n||generation>9223372036854775807n||getOwn(owned,"threadId")!==snapshot.thread||getOwn(owned,"truncated")===true)
    fail(snapshot.thread,"invalid or oversized historical observation");
  const turns=getOwn(owned,"turns");if(!Array.isArray(turns)||turns.length>128)fail(snapshot.thread,"historical turn page is invalid");
  const ids=new Set<string>();
  for(const turn of turns){const id=getOwn(turn,"id");if(typeof id!=="string"||id==="")fail(snapshot.thread,"historical turn identity is missing");
    if(ids.has(id))fail(snapshot.thread,"historical turn identity is duplicated");ids.add(id);}
  const db=await openInitialized(path);let committed=false;
  try{
    db.exec("BEGIN IMMEDIATE");
    if(fingerprint(snapshotIn(db,snapshot.thread))!==fingerprint(snapshot))fail(snapshot.thread,"historical review snapshot changed while reading");
    const digest=hash(encoded);let retained=0;
    for(const row of snapshot.rows){
      const turn=turns.find(t=>getOwn(t,"id")===row.turn_id);if(turn===undefined)continue;
      const evidence=candidate(row,turn,digest,observer,generation),key=evidence.review_key as string;
      if(!validCandidateIn(db,row,key,evidence))retainAsyncTerminalCandidateIn(db,row,"unverified",serializeSerdeValue(evidence));
      if(!validCandidateIn(db,row,key,evidence))fail(snapshot.thread,"historical candidate storage bound reached; receipt unchanged");
      if(evidence.answer_input_id!==null)db.prepare(`UPDATE cdr_async_execution_obligations SET answer_state='exact_history_confirmed',
        receipt_turn=turn_id WHERE question_id=? AND revision=? AND answer_state='unresolved'`).run(row.question_id,row.revision);
      retained++;
    }
    db.exec("COMMIT");committed=true;return retained;
  }finally{if(!committed&&db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}

import {asyncExecutionOwnerIn,ASYNC_QUESTION_CLAIM_SQL} from "./async-resolution-ownership.ts";
import {verifiedAsyncTerminalProofIn} from "./async-resolution-terminal.ts";
import type {ExecutionOwner} from "./async-resolution-proof.ts";
import {decodeOptionalI64} from "./sqlite-values.ts";
interface TerminalEntry {index:number;owner:ExecutionOwner;priorProof:string|null;sourceState:string;sourceError:string|null}
interface TerminalSnapshotData {history:SnapshotData;entries:TerminalEntry[]}
export interface TerminalHistorySnapshot {turnIds():readonly string[]}
const terminalSnapshots=new WeakMap<TerminalHistorySnapshot,TerminalSnapshotData>();
function exists(db:DatabaseSync,sql:string,...args:(string|bigint|null)[]):boolean{
  const query=db.prepare(sql);query.setReadBigInts(true);return decodeI64(query.get(...args)?.present,"present")!==0n;
}
function readText(db:DatabaseSync,row:Record<string,unknown>,name:string,optional=false):string|null {
  return decodeTextField(row[name],row[name+"_raw"],name,optional,textDecoderFor(db.prepare("PRAGMA encoding").get()?.encoding));
}
function terminalEntryIn(db:DatabaseSync,history:SnapshotData,index:number):TerminalEntry{
  const row=history.rows[index]!,q=originalHistoricalQuestion(row);
  if(row.policy!=="ordinary"&&row.policy!=="publishing_recovery")fail(history.thread,"unsupported historical execution policy");
  const mapped=exists(db,"SELECT COUNT(*)=1 AND MIN(codex_thread_id)=?2 AS present FROM mirror_threads WHERE discord_thread_id=?1",q.channel_id,q.thread_id);
  const query=db.prepare(`SELECT ${ASYNC_QUESTION_CLAIM_SQL} AS claim,CAST(${ASYNC_QUESTION_CLAIM_SQL} AS BLOB) AS claim_raw,
    q.preparation_json AS seal,CAST(q.preparation_json AS BLOB) AS seal_raw,q.state AS state,CAST(q.state AS BLOB) AS state_raw,
    q.error AS error,CAST(q.error AS BLOB) AS error_raw FROM cdr_async_questions q WHERE q.id=?`);
  const current=query.get(q.id);if(!current)fail(history.thread,"historical original question is missing");
  const claim=readText(db,current,"claim"),seal=readText(db,current,"seal",true),state=readText(db,current,"state")!,error=readText(db,current,"error",true);
  const conflict=exists(db,`SELECT EXISTS(SELECT 1 FROM cdr_async_terminal_candidates WHERE question_id=? AND revision=? AND
    (kind='conflict' OR CASE WHEN json_valid(evidence_text) THEN json_extract(evidence_text,'$.answer_conflict')=1 ELSE 0 END)) AS present`,q.id,row.revision);
  if(!mapped||claim!==row.claim||seal!==row.original_seal||(state!=="dispatching"&&state!=="submitted")||conflict)
    fail(history.thread,"historical original identity or evidence conflicts");
  const proofQuery=db.prepare(`SELECT length(CAST(terminal_proof_json AS BLOB)) AS size,
    CASE WHEN length(CAST(terminal_proof_json AS BLOB))<=131072 THEN terminal_proof_json END AS prior,
    CAST(CASE WHEN length(CAST(terminal_proof_json AS BLOB))<=131072 THEN terminal_proof_json END AS BLOB) AS prior_raw
    FROM cdr_async_execution_obligations WHERE question_id=?`);
  proofQuery.setReadBigInts(true);const proof=proofQuery.get(q.id);
  if(!proof)fail(history.thread,"historical original question is missing");
  const size=decodeOptionalI64(proof.size,"size"),prior=readText(db,proof,"prior",true);
  if(size!==null&&size>131072n)fail(history.thread,"prior terminal evidence exceeds the preservation bound");
  return {index,owner:asyncExecutionOwnerIn(db,row),priorProof:prior,sourceState:state,sourceError:error};
}
function terminalSnapshotIn(db:DatabaseSync,thread:string):TerminalSnapshotData|null{
  const history=snapshotIn(db,thread);
  if(exists(db,"SELECT EXISTS(SELECT 1 FROM codex_turn_queue WHERE target_thread_id=? AND state!='pending') AS present",thread))return null;
  const entries:TerminalEntry[]=[];
  for(let index=0;index<history.rows.length;index++){
    const row=history.rows[index]!;if(row.execution_state!=="unresolved")continue;
    if(exists(db,"SELECT EXISTS(SELECT 1 FROM codex_turn_queue WHERE job_id=?) AS present",row.origin_job_id))return null;
    entries.push(terminalEntryIn(db,history,index));
  }
  return entries.length===0?null:{history,entries};
}
export async function captureTerminalHistorySnapshot(path:string,thread:string):Promise<TerminalHistorySnapshot|null>{
  const db=await openInitialized(path);
  try{
    db.exec("BEGIN");const data=terminalSnapshotIn(db,thread);if(data===null)return null;
    const snapshot=Object.freeze({turnIds:()=>[...new Set(data.entries.map(e=>e.owner.turn_id))].sort(utf8Sort)});
    terminalSnapshots.set(snapshot,data);return snapshot;
  }finally{try{if(db.isTransaction)db.exec("ROLLBACK");}finally{db.close();}}
}
function terminalFingerprint(data:TerminalSnapshotData):string{
  // Both snapshots originate locally; encode the same ordered struct fields as Rust.
  const entries=data.entries.map(e=>'{"index":'+e.index+',"owner":'+
    '{"turn_id":'+serializeSerdeValue(e.owner.turn_id)+',"generation":'+serializeSerdeValue(e.owner.generation)+',"observer":'+serializeSerdeValue(e.owner.observer)+',"job":'+serializeSerdeValue(e.owner.job)+'}'+
    ',"prior_proof":'+serializeSerdeValue(e.priorProof)+',"source_state":'+serializeSerdeValue(e.sourceState)+',"source_error":'+serializeSerdeValue(e.sourceError)+'}');
  return '['+serializeSerdeValue(fingerprint(data.history))+',['+entries.join(',')+']]';
}
function terminalObservations(data:TerminalSnapshotData,observed:unknown):unknown[]{
  const thread=data.history.thread,invalid=():never=>fail(thread,"historical execution needs exact idle thread and explicit ended Goal");
  const metadata=getOwn(observed,"thread_observation"),goal=getOwn(getOwn(observed,"goal_observation"),"goal");
  if(goal===undefined)invalid();
  if(Buffer.byteLength(serializeSerdeValue(observed))>1048576||getOwn(observed,"threadId")!==thread||getOwn(observed,"truncated")===true||
    getOwn(getOwn(metadata,"thread"),"id")!==thread||getOwn(getOwn(getOwn(metadata,"thread"),"status"),"type")!=="idle"||
    !(goal===null||(getOwn(goal,"threadId")===thread&&getOwn(goal,"status")==="complete")))invalid();
  const turns=getOwn(observed,"turns");if(!Array.isArray(turns)||turns.length>128)return invalid();
  const ids=new Set<string>();for(const turn of turns){const id=getOwn(turn,"id");if(typeof id!=="string"||id===""||Buffer.byteLength(id)>512)return invalid();if(ids.has(id))invalid();ids.add(id);}
  return turns;
}
function historicalProofIn(db:DatabaseSync,data:TerminalSnapshotData,entry:TerminalEntry,observed:unknown,turns:unknown[],reader:string,generation:bigint):string{
  const row=data.history.rows[entry.index]!,invalid=():never=>fail(row.thread_id,"historical current logical owner lacks exact terminal evidence");
  const turn=turns.find(t=>getOwn(t,"id")===entry.owner.turn_id)??invalid(),status=getOwn(turn,"status");
  if(status!=="completed"&&status!=="failed"&&status!=="interrupted")invalid();
  if(entry.priorProof!==null){
    const prior=verifiedAsyncTerminalProofIn(db,row,entry.owner)??invalid();
    const old:unknown=parseSerdeValue(prior[0]);
    if(prior[0]!==entry.priorProof||getOwn(getOwn(getOwn(old,"canonical_terminal"),"turn"),"status")!==status)invalid();
  }
  const proof=serializeSerdeValue({version:1n,source:"historical_read_terminal_v1",observer:reader,generation,owner_verified:true,
    question_id:row.question_id,claim_sha256:row.claim_sha256,revision:row.revision,thread_id:row.thread_id,turn_id:entry.owner.turn_id,
    sealed_execution_owner:entry.owner,canonical_terminal:{threadId:row.thread_id,turn:{id:entry.owner.turn_id,status}},
    goal:getOwn(getOwn(observed,"goal_observation"),"goal"),history_sha256:hash(serializeSerdeValue(observed)),
    owner_turn_sha256:hash(serializeSerdeValue(turn)),thread_observation_sha256:hash(serializeSerdeValue(getOwn(observed,"thread_observation"))),previous_terminal_proof:entry.priorProof});
  if(Buffer.byteLength(proof)>131072)fail(row.thread_id,"historical proof exceeds preservation bound");return proof;
}
function settleHistoricalOneIn(db:DatabaseSync,data:TerminalSnapshotData,entry:TerminalEntry,proof:string):void{
  const row=data.history.rows[entry.index]!,invalid=():never=>fail(row.thread_id,"historical settlement lost its exact atomic certificate");
  if(row.revision===9223372036854775807n)invalid();
  const next=row.revision+1n,admission=row.policy==="ordinary"?"settled":"held",answer=row.answer_state==="unresolved"?"terminal_without_receipt":row.answer_state;
  if(BigInt(db.prepare(`UPDATE cdr_async_execution_obligations SET execution_state='terminal',admission_state=?,answer_state=?,revision=?,terminal_proof_json=?
    WHERE question_id=? AND revision=? AND execution_state='unresolved' AND terminal_proof_json IS ?`)
    .run(admission,answer,next,proof,row.question_id,row.revision,entry.priorProof).changes)!==1n)invalid();
  if(BigInt(db.prepare("INSERT INTO cdr_async_terminal_settlements(question_id,revision,proof_json) VALUES(?,?,?)").run(row.question_id,next,proof).changes)!==1n)invalid();
  if(entry.sourceState==="dispatching"&&BigInt(db.prepare("UPDATE cdr_async_questions SET state='closed_unknown' WHERE id=? AND state='dispatching' AND dispatch_mode='steer' AND preparation_json=?")
    .run(row.question_id,row.original_seal).changes)!==1n)invalid();
  if(!exists(db,`SELECT EXISTS(SELECT 1 FROM cdr_async_execution_obligations o JOIN cdr_async_terminal_settlements s ON s.question_id=o.question_id
    WHERE o.question_id=? AND o.revision=? AND s.revision=o.revision AND o.terminal_proof_json=? AND s.proof_json=o.terminal_proof_json
      AND o.execution_state='terminal' AND o.policy=? AND o.admission_state=? AND o.answer_state=?) AS present`,row.question_id,next,proof,row.policy,admission,answer))invalid();
}
export async function settleTerminalHistory(path:string,expected:TerminalHistorySnapshot,observed:unknown,reader:string,generation:bigint):Promise<number>{
  const data=terminalSnapshots.get(expected);if(!data)throw new TypeError("Expected a captured terminal history snapshot");
  if(typeof reader!=="string"||trim(reader)===""||Buffer.byteLength(reader)>256||typeof generation!=="bigint"||generation<0n||generation>9223372036854775807n)
    fail(data.history.thread,"historical reader identity is invalid");
  serializeSerdeValue(observed);const owned:unknown=structuredClone(observed),turns=terminalObservations(data,owned);
  const db=await openInitialized(path);let committed=false;
  try{
    db.exec("BEGIN IMMEDIATE");const current=terminalSnapshotIn(db,data.history.thread);
    if(current===null)fail(data.history.thread,"historical execution owner changed while reading");
    if(terminalFingerprint(current)!==terminalFingerprint(data))fail(data.history.thread,"historical execution snapshot changed while reading");
    for(const entry of data.entries)settleHistoricalOneIn(db,data,entry,historicalProofIn(db,data,entry,owned,turns,reader,generation));
    for(const entry of data.entries){const row=data.history.rows[entry.index]!,state=entry.sourceState==="dispatching"?"closed_unknown":"submitted";
      if(!exists(db,`SELECT EXISTS(SELECT 1 FROM cdr_async_questions q WHERE q.id=? AND q.state=? AND ${ASYNC_QUESTION_CLAIM_SQL}=?
        AND q.preparation_json IS ? AND q.error IS ?) AS present`,row.question_id,state,row.claim,row.original_seal,entry.sourceError))
        fail(row.thread_id,"historical settlement changed its original question");
    }
    db.exec("COMMIT");committed=true;return data.entries.length;
  }finally{if(!committed&&db.isTransaction){try{db.exec("ROLLBACK");}catch{/* close rolls back */}}db.close();}
}
