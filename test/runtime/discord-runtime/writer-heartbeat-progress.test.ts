import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtemp,realpath,stat,readdir,rmdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {AppServerWriter} from '../../../src/app-server/writer.ts';
import {AppServerClosedError} from '../../../src/app-server/client-errors.ts';
import {startRuntimeHeartbeatWorker} from '../../../src/runtime/discord-runtime/heartbeat-start.ts';
import {RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
import {posixRuntimeHeartbeatPort,RUNTIME_HEARTBEAT_NAME} from '../../../src/runtime/runtime-heartbeat.ts';
const WINDOW_MS=90000,CLEANUP_MS=15000;
function gate(){let release!:()=>void;const promise=new Promise<void>(r=>release=r);return {promise,release};}
function snapshot(w:AppServerWriter,operations:number,bytes:number,waiters:number,held:number){assert.deepEqual(w.snapshotRetainedWork(),{retainedWriteOperationCount:operations,retainedEncodedBufferBytes:bytes,stdinLock:{activeTargetCount:held?1:0,queuedWaiterCount:waiters,heldLeaseReferenceCount:held}});}
async function until(check:()=>boolean,deadline:number){while(!check()){assert.ok(performance.now()<deadline,'Fixed observation window expired; incomplete');await sleep(5);}}
function outcome<T>(p:Promise<T>){return p.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));}

test('component writer custody coexists with actual default heartbeat and independent POSIX observation',{timeout:WINDOW_MS+CLEANUP_MS+10000},async()=>{
 assert.notEqual(process.platform,'win32');assert.equal(process.version,'v24.21.0');
 const root=await mkdtemp(resolve('.runtime/writer-heartbeat-940-')),identity=await stat(root),canonical=await realpath(root),marker=join(root,RUNTIME_HEARTBEAT_NAME);
 const events:{name:string;at:number}[]=[],diagnostics:unknown[]=[],publications:{text:string;at:number}[]=[],samples:{kind:string;sequence:number;text?:string;started:number;ended:number}[]=[];
 const event=(name:string)=>events.push({name,at:performance.now()});
 const writeGate=gate(),flushGate=gate(),closeGate=gate(),disposeGate=gate(),publishGate=gate(),removeGate=gate();
 const aSignal=new AbortController(),bSignal=new AbortController(),cSignal=new AbortController(),aAbort=new Error('synthetic A cancellation'),cAbort=new Error('synthetic C cancellation');
 const admitted=Object.freeze({operation:'A'});let closed=false,writeEntered=false,flushEntered=false,closeEntered=false,disposeEntered=false,publishHeld=false,removeEntered=false,holdNextPublish=false;
 let aSettled=false,bSettled=false,closeCalls=0,preflightCalls=0,startCalls=0,disposed=0,observerReady=false,observerStopped=false,observerError='';
 const writer=new AppServerWriter({writeAll:async(bytes,signal)=>{assert.equal(signal,aSignal.signal);assert.equal(bytes.byteLength,4);assert.equal(bytes.toString(),'"A"\n');writeEntered=true;event('A.writeAll.enter');await writeGate.promise;signal?.throwIfAborted();event('A.writeAll.join');},flush:async(signal)=>{assert.equal(signal,aSignal.signal);flushEntered=true;event('A.flush.enter');await flushGate.promise;signal?.throwIfAborted();event('A.flush.join');}}, {get closed(){return closed;},markClosed:async()=>{closed=true;closeCalls++;closeEntered=true;event('A.markClosed.enter');await closeGate.promise;event('A.markClosed.join');}});
 const observerArgv=Object.freeze(['--no-strip-types',fileURLToPath(new URL('../../helpers/writer-heartbeat-marker-observer.js',import.meta.url)),marker]);
 assert.ok(observerArgv.length&&observerArgv.every(x=>x.length));
 const child=spawn(process.execPath,observerArgv,{stdio:['pipe','pipe','pipe'],env:{NODE_OPTIONS:'--no-strip-types'}});
 const childJoin=new Promise<void>((resolveJoin,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>{if(code===0&&signal===null)resolveJoin();else reject(new Error('Owned observer did not exit cleanly'));});});
 void childJoin.catch(()=>{});
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{assert.ok(line.length<1024);const value=JSON.parse(line);if(value.kind==='ready')observerReady=true;else if(value.kind==='stopped')observerStopped=true;else{assert.ok(samples.length<5000);assert.ok(['sample','absent','error'].includes(value.kind));samples.push(value);}}catch{observerError='invalid observer message';}});
 child.stderr.on('data',()=>{observerError='observer stderr';});
 const exits=new RuntimeWorkerExitChannel(),receiver=exits.receiver(),actual=posixRuntimeHeartbeatPort(marker);
 let owner:ReturnType<typeof startRuntimeHeartbeatWorker>|undefined,a:ReturnType<typeof outcome<object>>|undefined,b:ReturnType<typeof outcome<object>>|undefined,c:ReturnType<typeof outcome<object>>|undefined;
 let activePort=0,lastFulfilled:string|undefined,deadline=performance.now()+WINDOW_MS,completed=false,primaryFailure:unknown,cleanupFailure:unknown;
 const waitingPreflight={check:async()=>{assert.fail('Queued B/C must not reach preflight');return admitted;},validate:()=>assert.fail('Queued B/C validation'),dispose:async()=>assert.fail('Queued B/C disposal')};
 try{
  await until(()=>observerReady,deadline);
  a=outcome(writer.writeWithOwnedPreflight('A',{check:async()=>{preflightCalls++;return admitted;},validate:value=>assert.equal(value,admitted),dispose:async value=>{assert.equal(value,admitted);disposed++;disposeEntered=true;event('A.dispose.enter');await disposeGate.promise;event('A.dispose.join');}},()=>{assert.equal(closed,false);assert.equal(aSignal.signal.aborted,false);startCalls++;event('A.writeStarted');},aSignal.signal));void a.then(()=>{aSettled=true;});
  await until(()=>writeEntered,deadline);snapshot(writer,1,4,0,1);
  b=outcome(writer.writeWithOwnedPreflight('BB',waitingPreflight,()=>assert.fail('B start after close'),bSignal.signal));void b.then(()=>{bSettled=true;});
  c=outcome(writer.writeWithOwnedPreflight('é',waitingPreflight,()=>assert.fail('C start'),cSignal.signal));snapshot(writer,3,14,2,1);
  cSignal.abort(cAbort);const cr=await c;assert.equal(cr.ok,false);if(!cr.ok)assert.equal(cr.error,cAbort);snapshot(writer,2,9,1,1);event('C.cancel.join');
  deadline=performance.now()+WINDOW_MS;
  owner=startRuntimeHeartbeatWorker({publish:async text=>{assert.equal(activePort++,0);try{await actual.publish(text);publications.push({text,at:performance.now()});event('heartbeat.publish.actual');if(holdNextPublish){publishHeld=true;await publishGate.promise;}lastFulfilled=text;}finally{activePort--;}
  },removeIfOwned:async text=>{assert.equal(activePort++,0);try{assert.equal(text,lastFulfilled);removeEntered=true;event('heartbeat.remove.enter');await removeGate.promise;await actual.removeIfOwned(text);event('heartbeat.remove.actual');}finally{activePort--;}}},exits,{report:(name,error)=>{diagnostics.push({name,error});}});
  const observePublication=async(index:number)=>{await until(()=>publications.length>index,deadline);const text=publications[index]!.text,after=samples.length;await until(()=>samples.slice(after).some(s=>s.kind==='sample'&&s.text===text),deadline);assert.match(text,new RegExp(`^pid=${process.pid}\\nupdated_at=[0-9]+\\n$`));assert.equal(observerError,'');assert.equal(samples.some(s=>s.kind==='error'),false);assert.deepEqual(diagnostics,[]);};
  await observePublication(0);assert.equal(aSettled,false);snapshot(writer,2,9,1,1);event('write.blocked.observed');
  writeGate.release();await until(()=>flushEntered,deadline);const flushIndex=publications.length;await observePublication(flushIndex);assert.equal(aSettled,false);snapshot(writer,2,9,1,1);event('flush.blocked.observed');
  aSignal.abort(aAbort);await until(()=>closeEntered,deadline);assert.equal(aSettled,false);assert.equal(bSettled,false);snapshot(writer,2,9,1,1);
  flushGate.release();await sleep(5);assert.equal(disposeEntered,false);assert.equal(aSettled,false);snapshot(writer,2,9,1,1);event('markClosed.join.blocked');
  closeGate.release();await until(()=>disposeEntered,deadline);const disposeIndex=publications.length;await observePublication(disposeIndex);assert.equal(aSettled,false);assert.equal(bSettled,false);snapshot(writer,2,9,1,1);event('dispose.blocked.observed');
  disposeGate.release();const [ar,br]=await Promise.all([a,b]);assert.equal(ar.ok,false);if(!ar.ok)assert.equal(ar.error,aAbort);assert.equal(br.ok,false);if(!br.ok)assert.ok(br.error instanceof AppServerClosedError);snapshot(writer,0,0,0,0);assert.equal(closeCalls,1);assert.equal(preflightCalls,1);assert.equal(startCalls,1);assert.equal(disposed,1);event('writers.join.zero');
  holdNextPublish=true;const finalIndex=publications.length;await observePublication(finalIndex);assert.equal(publishHeld,true);owner.requestStop();assert.equal(owner.worker.peek(),undefined);event('stop.publish.pending');
  publishGate.release();await until(()=>removeEntered,deadline);assert.equal(owner.worker.peek(),undefined);const removeSampleStart=samples.length;await until(()=>samples.slice(removeSampleStart).some(s=>s.kind==='sample'&&s.text===lastFulfilled),deadline);assert.equal(owner.worker.peek(),undefined);event('stop.remove.pending');
  const absenceAfter=samples.length;removeGate.release();assert.deepEqual(await owner.worker.join(),{kind:'Returned',result:{ok:true}});await until(()=>samples.slice(absenceAfter).some(s=>s.kind==='absent'),deadline);assert.deepEqual(receiver.tryReceive(),{kind:'Value',value:'heartbeat'});assert.deepEqual(diagnostics,[]);assert.equal(activePort,0);assert.deepEqual(await readdir(root),[]);
  child.stdin.end('STOP\n');await childJoin;assert.equal(observerStopped,true);assert.equal(observerError,'');assert.equal(samples.some(s=>s.kind==='error'),false);assert.ok(new Set(samples.filter(s=>s.kind==='sample').map(s=>s.text)).size>=4);let previousSequence=0,previousEnd=0;for(const s of samples){assert.equal(s.sequence,previousSequence+1);assert.ok(s.started>=previousEnd);assert.ok(s.ended>=s.started);previousSequence=s.sequence;previousEnd=s.ended;}completed=true;
 }catch(error){primaryFailure=error;}
 finally{
  const cleanupStarted=performance.now();let cleanupJoined=false;
  const receipt=async()=>{if(process.env['WRITER_HEARTBEAT_RECEIPT'])await writeFile(process.env['WRITER_HEARTBEAT_RECEIPT'],JSON.stringify({completed:completed&&primaryFailure===undefined&&cleanupFailure===undefined,events,publicationCount:publications.length,observerDistinctLowerBound:new Set(samples.filter(s=>s.kind==='sample').map(s=>s.text)).size,observerReadCount:samples.length,observerDurationsMs:samples.map(s=>s.ended-s.started),diagnosticCount:diagnostics.length,cleanupJoined,cleanupDurationMs:performance.now()-cleanupStarted,primaryFailure:primaryFailure===undefined?null:String(primaryFailure),cleanupFailure:cleanupFailure===undefined?null:String(cleanupFailure)}));};
  try{
   for(const g of [writeGate,flushGate,closeGate,disposeGate,publishGate,removeGate])g.release();aSignal.abort(aAbort);bSignal.abort();cSignal.abort(cAbort);owner?.requestStop();if(!child.stdin.writableEnded)child.stdin.end();
   await receipt();
   const joins=Promise.all([a,b,c,owner?.worker.join(),childJoin]).then(()=>{cleanupJoined=true;});void joins.catch(()=>{});await until(()=>cleanupJoined,cleanupStarted+CLEANUP_MS);await joins;lines.close();receiver.dispose();exits.close();
   const now=await stat(root);assert.equal(await realpath(root),canonical);assert.equal(now.dev,identity.dev);assert.equal(now.ino,identity.ino);assert.deepEqual(await readdir(root),[]);await rmdir(root);
  }catch(error){cleanupFailure=error;}
  await receipt();
 }
 if(primaryFailure!==undefined&&cleanupFailure!==undefined)throw new AggregateError([primaryFailure,cleanupFailure],'Component and cleanup failed');
 if(primaryFailure!==undefined)throw primaryFailure;if(cleanupFailure!==undefined)throw cleanupFailure;
});

test('successful writer control proves surviving FIFO B advances after cancelled C',async()=>{
 const aw=gate(),af=gate(),bw=gate(),aSignal=new AbortController(),bSignal=new AbortController(),cSignal=new AbortController(),cancel=new Error('synthetic queued C');let writing='',aEntered=false,bEntered=false,flushEntered=false,disposed=0;const events:string[]=[];
 const writer=new AppServerWriter({writeAll:async(bytes,signal)=>{writing=bytes.toString();if(writing==='"A"\n'){assert.equal(signal,aSignal.signal);aEntered=true;await aw.promise;}else{assert.equal(writing,'"BB"\n');assert.equal(signal,bSignal.signal);bEntered=true;await bw.promise;}},flush:async()=>{if(writing==='"A"\n'){flushEntered=true;await af.promise;}}},{closed:false,markClosed:async()=>assert.fail('Success must not close')});
 const flight=(name:string)=>({check:async()=>{events.push(name+'.check');return name;},validate:(value:string)=>assert.equal(value,name),dispose:async()=>{disposed++;}});
 let a:ReturnType<typeof outcome<string>>|undefined,b:ReturnType<typeof outcome<string>>|undefined,c:ReturnType<typeof outcome<string>>|undefined;
 try{a=outcome(writer.writeWithOwnedPreflight('A',flight('A'),()=>{events.push('A.start');},aSignal.signal));await until(()=>aEntered,performance.now()+2000);b=outcome(writer.writeWithOwnedPreflight('BB',flight('B'),()=>{events.push('B.start');},bSignal.signal));c=outcome(writer.writeWithOwnedPreflight('é',flight('C'),()=>assert.fail('C start'),cSignal.signal));snapshot(writer,3,14,2,1);cSignal.abort(cancel);const cr=await c;assert.equal(cr.ok,false);if(!cr.ok)assert.equal(cr.error,cancel);snapshot(writer,2,9,1,1);aw.release();await until(()=>flushEntered,performance.now()+2000);snapshot(writer,2,9,1,1);af.release();await until(()=>bEntered,performance.now()+2000);assert.deepEqual(await a,{ok:true,value:'A'});snapshot(writer,1,5,0,1);assert.deepEqual(events,['A.check','A.start','B.check','B.start']);bw.release();assert.deepEqual(await b,{ok:true,value:'B'});snapshot(writer,0,0,0,0);assert.equal(disposed,0);
 }finally{aw.release();af.release();bw.release();cSignal.abort(cancel);await Promise.all([a,b,c]);}
});
