import {readBackendAsyncHistory,readBackendAsyncTerminal,type BackendHistoryPort} from "./app-backend-history.ts";
import {PortableResidentLifecycle,type NativeRecoveryObservation} from "../app-server/portable-resident-lifecycle.ts";
import {forkThreadPersistent,readThreadWithTimeout,resumeThreadWithTimeout,startTurn,startTurnWithInput} from "../app-server/requests.ts";
import {parseThreadTurnStates} from "../app-server/outcomes.ts";
import {extractThreadId} from "../app-server/identity.ts";
import {serdeField,rustTrim} from "../app-server/value.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {snapshotStoredQueueJob,serializeStoredQueueJob,type StoredQueueJob} from "../store/queue-read.ts";
import {BackendFailureError} from "./queue-runner/errors.ts";
import type {QueueStartBackend,QueueAttemptClaim} from "./queue-runner/start-coordinator.ts";
import {createAppBackendErrors} from "./app-backend-errors.ts";
import {buildProTurnInput} from "../pro/prompt.ts";
function text(value:unknown):asserts value is string{if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed backend text");}
function generation(value:unknown):asserts value is bigint{if(typeof value!=="bigint"||value<0n||value>=(1n<<64n))throw new RangeError("Expected u64 backend generation");}
function invalid(message:string,ambiguous=false):never{throw new BackendFailureError({message,ambiguous,kind:"Other"});}
/** Source-compatible prompt DTO only. This code never invokes another reviewer/agent. */
export function appBackendTurnInput(prompt:string,path:string):readonly unknown[]{
  text(prompt);text(path);return buildProTurnInput(prompt,path);
}
/** Core real-resident queue adapter. Fresh-thread knowledge is process-generation
 * local and consumed before every start attempt. Historical JSON remains evidence;
 * recovery release proofs use the separate opaque actual-native owner path. */
export class AppServerTurnBackend implements QueueStartBackend{
  readonly #server:PortableResidentLifecycle;readonly #errors:ReturnType<typeof createAppBackendErrors>;
  readonly #fresh=new Map<string,bigint>();readonly #resumeMs:number;readonly #historyMs:number;readonly #proPath:string|null;
  constructor(server:PortableResidentLifecycle,render:(error:unknown)=>string,options:{readonly resumeTimeoutMs?:number;readonly historyTimeoutMs?:number;readonly proSkillPath?:string|null}={}){
    this.#server=server;this.#errors=createAppBackendErrors(render);const own=cloneOwnedSerdeValue(options) as typeof options;
    this.#resumeMs=own.resumeTimeoutMs??60_000;this.#historyMs=own.historyTimeoutMs??60_000;this.#proPath=own.proSkillPath??null;
    for(const v of [this.#resumeMs,this.#historyMs])if(!Number.isSafeInteger(v)||v<0||v>2147483647)throw new RangeError("Expected supported backend timeout");if(this.#proPath!==null)text(this.#proPath);
  }
  generation():bigint{return this.#server.generation();}
  residentInstanceId():string{return this.#server.instanceId;}
  requiresAppServerFork():boolean{return false;}
  rememberNewThread(thread:string,g:bigint):void{text(thread);generation(g);for(const [id,old] of this.#fresh)if(old!==g)this.#fresh.delete(id);this.#fresh.set(thread,g);}
  async activeTurnId(thread:string,signal?:AbortSignal):Promise<string|null>{text(thread);signal?.throwIfAborted();return this.#errors.run("read",async()=>this.#server.activeTurnId(thread),signal);}
  async readTurns(thread:string,signal?:AbortSignal){
    text(thread);signal?.throwIfAborted();const g=this.generation();if(this.#fresh.get(thread)===g)return [];
    const result=await this.#errors.run("read",()=>this.#server.execute(readThreadWithTimeout(thread,true,this.#historyMs),g,signal),signal);
    try{return [...parseThreadTurnStates(result,thread).values()].map(turn=>Object.freeze({turnId:turn.turnId,status:turn.status}));}catch(error){throw this.#errors.failure("read",error);}
  }
  async resumeThread(thread:string,signal?:AbortSignal):Promise<void>{
    text(thread);signal?.throwIfAborted();const g=this.generation();if(this.#fresh.get(thread)===g)return;
    const result=await this.#errors.run("resume",()=>this.#server.execute(resumeThreadWithTimeout(thread,this.#resumeMs),g,signal),signal);
    if(serdeField(serdeField(result,"thread"),"id")!==thread)invalid("thread/resume returned a different or invalid thread");
  }
  async forkThread(thread:string):Promise<string>{
    text(thread);const result=await this.#errors.run("mutation",()=>this.#server.execute(forkThreadPersistent(thread,this.#resumeMs),this.generation()));
    const forked=extractThreadId(result);if(forked===null||forked===thread)invalid("thread/fork returned no distinct thread id",true);return forked;
  }
  startTurn(thread:string,prompt:string):Promise<string>{return this.#start(thread,prompt,null);}
  startClaimedTurn(input:QueueAttemptClaim):Promise<string>{
    const job=snapshotStoredQueueJob(cloneOwnedSerdeValue(input) as StoredQueueJob);return this.#start(job.targetThreadId,job.prompt,job);
  }
  async #start(thread:string,prompt:string,claim:StoredQueueJob|null):Promise<string>{
    text(thread);text(prompt);const request=this.#proPath===null?startTurn(thread,prompt):startTurnWithInput(thread,appBackendTurnInput(prompt,this.#proPath));this.#fresh.delete(thread);
    let authority:unknown,g:bigint;if(claim!==null){try{g=claim.appServerGeneration;generation(g);authority=parseSerdeValue(serializeStoredQueueJob(claim));}catch(error){throw this.#errors.failure("read",error);}}
    else g=this.generation();
    const result=await this.#errors.run(claim===null?"start":"claimedStart",()=>claim===null?this.#server.execute(request,g):this.#server.executeQueueTurn(request,g,authority));
    const id=serdeField(serdeField(result,"turn"),"id");if(typeof id!=="string"||rustTrim(id)==="")invalid("turn/start returned no turn id",true);return rustTrim(id);
  }
  #historyPort():BackendHistoryPort{return {generation:()=>this.generation(),request:(request,g,signal)=>this.#errors.run("read",()=>this.#server.execute(request,g,signal),signal)};}
  readAsyncHistory(thread:string,originals:readonly string[],signal?:AbortSignal):Promise<unknown|null>{return readBackendAsyncHistory(this.#historyPort(),thread,originals,this.#historyMs,signal);}
  readAsyncTerminal(thread:string,owners:readonly string[],signal?:AbortSignal):Promise<unknown|null>{return readBackendAsyncTerminal(this.#historyPort(),thread,owners,this.#historyMs,signal);}
  readRecoveryPrerequisites(thread:string,owners:readonly string[],signal?:AbortSignal):Promise<NativeRecoveryObservation>{return this.#errors.run("read",()=>this.#server.observeRecoveryPrerequisites(thread,owners,this.#historyMs,signal),signal);}
}
