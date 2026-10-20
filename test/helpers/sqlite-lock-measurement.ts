import assert from 'node:assert/strict';
import workerThreads,{Worker,type WorkerOptions} from 'node:worker_threads';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import {OwnedWorkerSlot,OwnedWorkerTimeoutError,ownedWorkerUsage,ownedWorkerModuleUrl} from '../../src/runtime/owned-worker-slot.ts';

export const LIMITS=Object.freeze({nativeMs:5000,lockReleaseMs:6500,exitReleaseMs:7500,conditionMs:15000,wholeMs:120000,maxProbes:6000,maxEvents:20000,probePeriodMs:25,maxFaults:1,maxLockHolders:1,maxProbers:1});
export const now=()=>process.hrtime.bigint();
export type Event={kind:string;at:string;[key:string]:unknown};
export class Recording{
 readonly events:Event[]=[];
 event(kind:string,fields:Record<string,unknown>={}):void{assert.ok(this.events.length<LIMITS.maxEvents,'event cap');this.events.push({kind,at:String(now()),...fields});}
}
export async function until(check:()=>boolean,label:string):Promise<void>{const end=now()+BigInt(LIMITS.conditionMs)*1_000_000n;while(!check()){assert.ok(now()<end,`Condition guard: ${label}`);await new Promise(r=>setTimeout(r,5));}}
export async function bounded<T>(pending:Promise<T>,label:string):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([pending,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error(`Condition guard: ${label}`)),LIMITS.conditionMs);})]);}finally{clearTimeout(timer);}}
export function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});return {promise,resolve,reject};}
export type WorkerLife={number:number;role:string;module:string;operation:string|null;id:string|null;constructed:string;exit:string|null;code:number|null;errors:number};
export type Fault={id:string;mode:'lock'|'ack-loss';anchor:SharedArrayBuffer;trace:SharedArrayBuffer;metadata:SharedArrayBuffer;submitted:string|null;worker:WorkerLife|null;lowerTimerScheduled:string|null;lowerTimerDelay:number|null;lowerTimerFired:string|null;preExitObservation:{at:string;control:number;handlerSettled:boolean}|null;rejection:string|null;handlerSettled:boolean;slot:OwnedWorkerSlot|null;lock:LockOwner|null};
export function makeFault(id:string,mode:Fault['mode']):Fault{return {id,mode,anchor:new SharedArrayBuffer(8),trace:new SharedArrayBuffer(12*8),metadata:new SharedArrayBuffer(4096),submitted:null,worker:null,lowerTimerScheduled:null,lowerTimerDelay:null,lowerTimerFired:null,preExitObservation:null,rejection:null,handlerSettled:false,slot:null,lock:null};}
export class LockOwner{
 readonly worker:Worker;readonly ready=deferred<void>();readonly joined=deferred<number>();readonly messages:Record<string,unknown>[]=[];exited=false;
 constructor(path:string,fault:Fault,recording:Recording){
  this.worker=new Worker(ownedWorkerModuleUrl(new URL('./sqlite-lock-holder-worker.ts',import.meta.url),import.meta.url),{workerData:{path,anchor:fault.anchor,releaseMs:LIMITS.lockReleaseMs,guardMs:LIMITS.conditionMs}});
  this.worker.on('message',message=>{this.messages.push(message);recording.event('lock-'+String(message.kind),{id:fault.id,...message});if(message.kind==='locked')this.ready.resolve();});
  this.worker.on('error',error=>this.ready.reject(error));this.worker.once('exit',code=>{this.exited=true;this.joined.resolve(code);if(code!==0)this.ready.reject(Error('Lock worker failed'));});
 }
 async cleanup(){if(!this.exited)this.worker.postMessage({kind:'cleanup'});return bounded(this.joined.promise,'lock worker exit');}
}
const journalSource=new URL('../../src/runtime/message-worker/native-journal-worker.ts',import.meta.url);
const journalExecutable=ownedWorkerModuleUrl(journalSource,import.meta.url);
const slotExecutable=ownedWorkerModuleUrl(new URL('../../src/runtime/owned-worker-slot.ts',import.meta.url),import.meta.url);
/** Test-only observer. Only exact original Result URL + operation + ID + DB path
 * selects the fault wrapper. Normal workers and their ACKs remain unchanged. */
export function instrument(path:string,recording:Recording){
 const Original=Worker,originalTimer=globalThis.setTimeout,originalRun=OwnedWorkerSlot.prototype.run,originalComplete=OwnedWorkerSlot.prototype.runControlCompletion;
 const workers:WorkerLife[]=[],handles=new Set<Worker>(),slots=new Set<OwnedWorkerSlot>();let fault:Fault|null=null,pendingTimer:Fault|null=null;
 const journal:{operation:string;id:string;at:string}[]=[];
 class ObservedWorker extends Original{
  constructor(filename:string|URL,options?:WorkerOptions){
   const data=options?.workerData as Record<string,unknown>|undefined;
   const selected=fault!==null&&filename instanceof URL&&filename.href===journalExecutable.href&&data?.operation==='Result'&&data.id===fault.id&&data.path===path;
   const chosen=selected?fault!:null;
   if(chosen){
    assert.equal(chosen.worker,null,'exact Result intercepted once');
    const key='checkpoint929-exact-result',prior=workerThreads.getEnvironmentData(key);
    workerThreads.setEnvironmentData(key,{trace:chosen.trace,metadata:chosen.metadata,anchor:chosen.anchor,drop:chosen.mode==='ack-loss',exitMs:LIMITS.exitReleaseMs});
    // Side-channel evidence is separate from the production ACK. Original data
    // and module are unchanged; original SQL call and ACK payload are preserved.
    const script=`import {parentPort,getEnvironmentData} from 'node:worker_threads';import {DatabaseSync} from 'node:sqlite';
const c=getEnvironmentData(${JSON.stringify(key)}),t=new BigInt64Array(c.trace),a=new BigInt64Array(c.anchor),stamp=i=>Atomics.store(t,i,process.hrtime.bigint());
process.argv[1]=${JSON.stringify(fileURLToPath(journalExecutable))};
const exec=DatabaseSync.prototype.exec,post=parentPort.postMessage.bind(parentPort);
DatabaseSync.prototype.exec=function(sql){if(sql!=='BEGIN IMMEDIATE')return exec.call(this,sql);Atomics.add(t,9,1n);const meta={sqlite:this.prepare('SELECT sqlite_version() AS version').get().version,busyTimeout:this.prepare('PRAGMA busy_timeout').get(),journalMode:this.prepare('PRAGMA journal_mode').get(),synchronous:this.prepare('PRAGMA synchronous').get(),foreignKeys:this.prepare('PRAGMA foreign_keys').get()};const bytes=Buffer.from(JSON.stringify(meta));if(bytes.length>4088)throw Error('metadata cap');new Uint8Array(c.metadata,8).set(bytes);Atomics.store(new Int32Array(c.metadata,0,2),0,bytes.length);stamp(1);try{const v=exec.call(this,sql);Atomics.store(t,3,1n);return v;}catch(e){Atomics.store(t,3,e.code==='ERR_SQLITE_ERROR'&&e.errcode===5?2n:3n);throw e;}finally{stamp(2);}};
parentPort.postMessage=(value)=>{Atomics.add(t,10,1n);stamp(4);Atomics.store(t,5,value?.ok===true?1n:2n);if(c.drop){Atomics.store(t,6,1n);return;}post(value);};
stamp(0);try{await import(${JSON.stringify(journalExecutable.href)});}finally{stamp(7);DatabaseSync.prototype.exec=exec;const target=Atomics.load(a,0)+BigInt(c.exitMs)*1000000n;while(process.hrtime.bigint()<target){const remaining=Number(target-process.hrtime.bigint())/1e6;if(remaining>0)Atomics.wait(new Int32Array(c.trace,88,2),0,0,remaining);}stamp(8);}
`;
    try{super(new URL('data:text/javascript,'+encodeURIComponent(script)),options);}finally{workerThreads.setEnvironmentData(key,prior);}
   }else super(filename,options);
   const role=filename instanceof URL&&filename.href===ownedWorkerModuleUrl(new URL('./sqlite-lock-holder-worker.ts',import.meta.url),import.meta.url).href?'lock-holder':filename instanceof URL&&filename.href===ownedWorkerModuleUrl(new URL('./sqlite-lock-probe-worker.ts',import.meta.url),import.meta.url).href?'probe':'native';
   const life:WorkerLife={number:workers.length+1,role,module:filename instanceof URL?filename.pathname:String(filename),operation:typeof data?.operation==='string'?data.operation:null,id:typeof data?.id==='string'?data.id:null,constructed:String(now()),exit:null,code:null,errors:0};workers.push(life);handles.add(this);recording.event('worker-constructed',{number:life.number,role,id:life.id,operation:life.operation});
   this.on('error',()=>life.errors++);this.once('exit',code=>{life.exit=String(now());life.code=code;handles.delete(this);recording.event('worker-exit',{number:life.number,code});});
   if(chosen){chosen.worker=life;assert.equal(pendingTimer,null);pendingTimer=chosen;}
  }
 }
 globalThis.setTimeout=((callback:(...args:any[])=>void,delay?:number,...args:any[])=>{
  const capture=pendingTimer;if(capture===null)return originalTimer(callback,delay,...args);
  pendingTimer=null;assert.ok(new Error().stack?.includes(fileURLToPath(slotExecutable)),'timer originates in exact native owner');assert.ok(typeof delay==='number'&&delay>0&&delay<=LIMITS.nativeMs,'unchanged native timer');capture.lowerTimerScheduled=String(now());capture.lowerTimerDelay=delay;recording.event('native-timer-scheduled',{id:capture.id,delay});
  return originalTimer((...values:any[])=>{capture.lowerTimerFired=String(now());callback(...values);capture.preExitObservation={at:String(now()),control:ownedWorkerUsage().Control,handlerSettled:capture.handlerSettled};recording.event('native-timer-fired',{id:capture.id,...capture.preExitObservation});},delay,...args);
 }) as typeof setTimeout;
 workerThreads.Worker=ObservedWorker as typeof Worker;syncBuiltinESMExports();
 function observe(url:URL,data:unknown,timeout:number,slot:OwnedWorkerSlot){slots.add(slot);if(url.href!==journalSource.href&&url.href!==journalExecutable.href)return;const q=data as Record<string,unknown>;assert.equal(q.path,path);assert.equal(timeout,LIMITS.nativeMs);assert.equal(typeof q.id,'string');assert.equal(typeof q.operation,'string');journal.push({operation:q.operation as string,id:q.id as string,at:String(now())});recording.event('journal-submission',{operation:q.operation,id:q.id});}
 OwnedWorkerSlot.prototype.run=function(...args:Parameters<typeof originalRun>){
  observe(args[0],args[1],args[2],this);const q=args[1] as Record<string,unknown>,chosen=fault;
  const selected=chosen!==null&&chosen.mode==='lock'&&(args[0].href===journalSource.href||args[0].href===journalExecutable.href)&&q.operation==='Begin'&&q.id===chosen.id&&q.path===path;
  const pending=originalRun.apply(this,args); // Preserve synchronous admission.
  if(!selected)return pending;
  return pending.then(async value=>{await this.join();assert.equal(chosen!.lock,null);chosen!.lock=new LockOwner(path,chosen!,recording);await bounded(chosen!.lock.ready.promise,'independent BEGIN IMMEDIATE after exact joined Begin');return value;});
 };
 OwnedWorkerSlot.prototype.runControlCompletion=function(...args:Parameters<typeof originalComplete>){
  observe(args[0],args[1],args[2],this);const q=args[1] as Record<string,unknown>,selected=fault!==null&&(args[0].href===journalSource.href||args[0].href===journalExecutable.href)&&q.operation==='Result'&&q.id===fault.id&&q.path===path;
  if(!selected)return originalComplete.apply(this,args);
  const chosen=fault!;chosen.slot=this;
  if(chosen.mode==='lock')assert.ok(chosen.lock?.messages.some(message=>message.kind==='locked'),'lock is confirmed before Result');
   chosen.submitted=String(now());Atomics.store(new BigInt64Array(chosen.anchor),0,BigInt(chosen.submitted));recording.event('fault-forward',{id:chosen.id,mode:chosen.mode});
   const pending=originalComplete.apply(this,args); // Preserve immediate slot.busy.
   return pending.catch(error=>{assert.ok(error instanceof OwnedWorkerTimeoutError,'real lower timeout survives join');chosen.rejection=error.name;recording.event('native-rejection-after-join',{id:chosen.id,error:error.name});throw error;});
 };
 return {workers,journal,handles,arm(next:Fault){assert.equal(fault,null);fault=next;},disarm(){assert.ok(fault?.worker?.exit);assert.equal(pendingTimer,null);fault=null;},async join(){await bounded(Promise.all([...slots].map(s=>s.join())),'owned native slots');assert.equal(handles.size,0,'all exact constructed workers exited');},restore(){assert.equal(pendingTimer,null);OwnedWorkerSlot.prototype.run=originalRun;OwnedWorkerSlot.prototype.runControlCompletion=originalComplete;workerThreads.Worker=Original;globalThis.setTimeout=originalTimer;syncBuiltinESMExports();}};
}
export class ProbeOwner{
 readonly worker:Worker;readonly ready=deferred<void>();readonly stopped=deferred<any>();readonly joined=deferred<number>();readonly injections=new Map<number,ReturnType<typeof deferred<void>>>();readonly samples:{at:string;usage:ReturnType<typeof ownedWorkerUsage>}[]=[];exited=false;count=0;
 constructor(recording:Recording,inject:(id:string,label:string,wire:{planned:string;sent:string;main:string})=>Promise<void>){
  this.worker=new Worker(ownedWorkerModuleUrl(new URL('./sqlite-lock-probe-worker.ts',import.meta.url),import.meta.url),{workerData:{periodMs:LIMITS.probePeriodMs,maxProbes:LIMITS.maxProbes,wholeMs:LIMITS.wholeMs}});
  this.worker.on('message',message=>{if(message.kind==='ready')this.ready.resolve();else if(message.kind==='probe'){const main=String(now());this.samples.push({at:main,usage:ownedWorkerUsage()});recording.event('probe-observed',{sequence:message.sequence});this.worker.postMessage({kind:'ack',sequence:message.sequence,main});}else if(message.kind==='inject'){const main=String(now()),entry=this.injections.get(message.sequence);assert.ok(entry);void inject(message.id,message.label,{planned:message.planned,sent:message.sent,main}).then(()=>entry.resolve(),e=>entry.reject(e));}else if(message.kind==='stopping')this.worker.postMessage({kind:'finish-stop'});else if(message.kind==='stopped')this.stopped.resolve(message);else if(message.kind==='failure')this.stopped.reject(Error('Independent probe cap'));});
  this.worker.on('error',error=>{this.ready.reject(error);this.stopped.reject(error);});this.worker.once('exit',code=>{this.exited=true;this.joined.resolve(code);});
 }
 inject(id:string,label:string){const sequence=++this.count,entry=deferred<void>();this.injections.set(sequence,entry);this.worker.postMessage({kind:'inject',sequence,id,label,planned:String(now())});return bounded(entry.promise,'handler '+label);}
 async drain(){await bounded(Promise.allSettled([...this.injections.values()].map(entry=>entry.promise)),'actual handler/injection joins');}
 async stop(){if(!this.exited)this.worker.postMessage({kind:'stop'});const result=await bounded(this.stopped.promise,'probe report');assert.equal(await bounded(this.joined.promise,'probe exit'),0);return result;}
}
export function faultEvidence(fault:Fault){const trace=Array.from(new BigInt64Array(fault.trace),String),length=Atomics.load(new Int32Array(fault.metadata,0,2),0);return {id:fault.id,mode:fault.mode,submitted:fault.submitted,worker:fault.worker,lowerTimerScheduled:fault.lowerTimerScheduled,lowerTimerDelay:fault.lowerTimerDelay,lowerTimerFired:fault.lowerTimerFired,preExitObservation:fault.preExitObservation,rejection:fault.rejection,trace:{moduleStart:trace[0],sqliteBeginStart:trace[1],sqliteBeginEnd:trace[2],sqliteOutcome:trace[3],ackAttempt:trace[4],ackOk:trace[5],ackDropped:trace[6],moduleComplete:trace[7],exitBarrierRelease:trace[8],sqliteBeginCalls:trace[9],ackAttempts:trace[10]},actualConnection:length?JSON.parse(Buffer.from(new Uint8Array(fault.metadata,8,length)).toString()):null,lock:fault.lock?.messages??[]};}
