import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,realpathSync,lstatSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {setupPromptRuntime} from '../../helpers/native-server-prompt-runtime-fixture.ts';
import {promptHttpFixture,promptHttpMessage} from '../../helpers/server-prompt-http-fixture.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {openExisting} from '../../../src/store/existing-store.ts';
import {getIngressIn} from '../../../src/store/ingress-read.ts';
import {storeAuthorityEnrolled} from '../../../src/store/store-authority-domain.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {createPreparedMessageHandler} from '../../../src/runtime/discord-runtime/message-bootstrap.ts';
import {planPrefix} from '../../../src/runtime/prefix-plan.ts';
import {planMessage} from '../../../src/runtime/message-plan.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {LIMITS,Recording,ProbeOwner,makeFault,instrument,faultEvidence,bounded,until,now,type Fault} from '../../helpers/sqlite-lock-measurement.ts';
const TEXT='Rust button QA contracts are enabled: busy, approval, input, one-use claim, and retry release.';
const ERROR='Message journal outcome unavailable after native join; no automatic response or replay';
const ids=Object.freeze(Array.from({length:9},(_,i)=>(9007199254740993n+BigInt(i)).toString()));
const plan=Object.freeze({checkpoint:929,command:'!qa buttons',ids,unique:9,handlerInvocations:13,journal:{Admit:13,Begin:9,Result:9,Confirm:5,Hold:4},totalJournal:40,faults:['lock','lock','lock','ack-loss'],limits:LIMITS,interpretation:'Partial synthetic G3/G4 evidence only; no performance/full qualification'});
const cleanUsage={Background:0,Control:0,Observation:0,Discovery:0,Maintenance:0};
function inspect(path:string,id:string){const db=new DatabaseSync(path,{readOnly:true});try{const row=getIngressIn(db,`message:${id}`);assert.ok(row);const receipt=(domain:string,segment:string)=>db.prepare('SELECT message_id FROM codex_delivery_receipts WHERE receipt_key=?').get(serializeSerdeValue([1n,domain,`inbound-message/${id}/${segment}`,0n]));const hold=db.prepare('SELECT count(*) AS count FROM codex_delivery_outbox WHERE delivery_id=?').get(`ingress-hold:message:${id}`);return {row,actionReceipt:receipt('message/reply/v1','action-result')??null,errorReceipt:receipt('message/error/v1','error-report')??null,holds:Number(hold?.count)};}finally{db.close();}}
function stats(values:number[]){if(values.length===0)return {count:0,min:null,p50:null,p95:null,max:null};const sorted=[...values].sort((a,b)=>a-b),at=(p:number)=>sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]!;return {count:values.length,min:sorted[0],p50:at(.5),p95:at(.95),max:sorted.at(-1)};}
function ms(a:string,b:string){return Number(BigInt(b)-BigInt(a))/1e6;}
function metadata(path:string){const db=openExisting(path);try{return {node:process.version,sqlite:db.prepare('SELECT sqlite_version() AS version').get()?.version,busyTimeout:db.prepare('PRAGMA busy_timeout').get(),journalMode:db.prepare('PRAGMA journal_mode').get(),synchronous:db.prepare('PRAGMA synchronous').get(),foreignKeys:db.prepare('PRAGMA foreign_keys').get()};}finally{db.close();}}

test('929 installed prepared message real SQLite lock, joined timeout and distinct committed ACK loss',{timeout:LIMITS.wholeMs},async t=>{
 assert.equal(planPrefix('qa buttons'),'QaButtons');assert.deepEqual(planMessage({content:'!qa buttons',messageContentEnabled:true,channelAllowed:true,userAllowed:true,authorIsBot:false,authorIsSelf:false,authorMentionsBridge:false,hasAttachments:false,mirroredTarget:false,mentionedUserIds:[],requiredPlainAskUserIds:[]}),{Execute:'QaButtons'});
 assert.equal(process.version,'v24.21.0');assert.ok(process.execArgv.includes('--no-strip-types'));
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'cdr-sqlite-929-')),identity=lstatSync(root),path=join(root,'store.sqlite');
 const record=new Recording(),faults:Fault[]=[],invocations:Record<string,unknown>[]=[],outcomes:Record<string,unknown>[]=[],reports:{code:string;detail:string;at:string}[]=[],cleanupDebt:string[]=[];
 let server:PortableResidentLifecycle|undefined,probe:ProbeOwner|undefined,watch:ReturnType<typeof instrument>|undefined,probeReport:any=null,environment:unknown,completed=false,failure:unknown;
 const started=String(now());
 try{
  (await openInitialized(path)).close();environment=metadata(path);assert.equal(storeAuthorityEnrolled(path),false);
  const code="import readline from 'node:readline';readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',line=>{const q=JSON.parse(line);if(q.id!==undefined)process.stdout.write(JSON.stringify({id:q.id,result:{}})+'\\n');});";
  server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--no-strip-types','--input-type=module','-e',code],environment:{}},clientInfo:{name:'sqlite-measurement',title:'Synthetic fixture',version:'929'}},()=> 'fixture',{persistDeadWork(){},oldChildExited(){}});
  const f=setupPromptRuntime(path,server);
  for(const name of ['admitIngress','recordIngressProcessingMode','beginIngressExecution','recordNewInput','recordIngressResult','confirmIngress','holdIngress'] as const)t.mock.method(state,name,()=>assert.fail(`Compatibility journal used: ${name}`));
  watch=instrument(path,record);const watched=watch;
  await promptHttpFixture(async(http,seen)=>{
   const handler=createPreparedMessageHandler(f.startup,f.gate,http,{...f.options,report:(code,detail)=>{reports.push({code,detail,at:String(now())});record.event('runtime-report',{code});}});
   probe=new ProbeOwner(record,async(id,label,wire)=>{const entry={id,label,...wire,settled:null as string|null,fulfilled:false};invocations.push(entry);record.event('handler-start',{id,label});try{await handler(decodeGatewayMessage(JSON.stringify(promptHttpMessage(id,'!qa buttons'))),{applicationId:4n,userId:9n},new AbortController().signal);entry.fulfilled=true;}finally{entry.settled=String(now());const active=faults.find(x=>x.id===`message:${id}`);if(active)active.handlerSettled=true;record.event('handler-settled',{id,label,fulfilled:entry.fulfilled});}});
   try{
   await bounded(probe.ready.promise,'independent probe ready');
   async function success(id:string,label:string){const before=seen.length,reportBefore=reports.length;await probe!.inject(id,label);const found=inspect(path,id);assert.equal(found.row.eventId,BigInt(id));assert.equal(found.row.sourceMessageId,BigInt(id));assert.equal(found.row.state,'completed');assert.equal(found.row.confirmationDelivered,true);assert.deepEqual(found.row.outcome,{response:TEXT,waits_for_final:false});assert.ok(found.actionReceipt?.message_id);assert.equal(found.errorReceipt,null);assert.equal(found.holds,0);assert.equal(seen.length,before+1);assert.equal(seen.at(-1)?.method,'POST');assert.equal(JSON.parse(seen.at(-1)!.body).content,TEXT);assert.equal(reports.length,reportBefore);outcomes.push({id,label,state:'completed',confirmed:true,actionPosts:1,errorPosts:0,holdNotices:0});assert.deepEqual(ownedWorkerUsage(),cleanUsage);}
   await success(ids[0]!,'baseline');
   for(let round=0;round<4;round++){
    const id=ids[round*2+1]!,fresh=ids[round*2+2]!,mode=round===3?'ack-loss':'lock',fault=makeFault(`message:${id}`,mode);faults.push(fault);watched.arm(fault);
    const before=seen.length,reportBefore=reports.length,pending=probe.inject(id,`${mode}-${round+1}`);
    // No new operation is admitted while this original remains unsettled.
    await until(()=>fault.lowerTimerFired!==null,'actual lower native timer fires');
    assert.ok(fault.preExitObservation);assert.equal(fault.preExitObservation.control,1);assert.equal(fault.preExitObservation.handlerSettled,false);assert.equal(fault.worker?.exit,null);assert.equal(fault.handlerSettled,false);assert.equal(fault.slot?.busy,true);assert.equal(seen.length,before);assert.equal(reports.length,reportBefore);
    await pending;assert.equal(fault.rejection,'OwnedWorkerTimeoutError');assert.ok(fault.worker?.exit);assert.equal(fault.worker.code,0);assert.equal(fault.slot?.busy,false);
    const invocation=invocations.find(x=>x.id===id)!;assert.ok(BigInt(invocation.settled as string)>=BigInt(fault.worker.exit!));
    const rejected=record.events.find(x=>x.kind==='native-rejection-after-join'&&x.id===fault.id)!;assert.ok(rejected);assert.ok(BigInt(rejected.at)>=BigInt(fault.worker.exit!));
    const held=watched.journal.filter(x=>x.id===fault.id&&x.operation==='Hold');assert.equal(held.length,1);assert.ok(BigInt(held[0]!.at)>=BigInt(fault.worker.exit!));
    if(fault.lock)assert.equal(await bounded(fault.lock.joined.promise,'independent lock exit'),0);
    const evidence=faultEvidence(fault),trace=evidence.trace,submitted=BigInt(evidence.submitted!);
    assert.ok(BigInt(trace.sqliteBeginStart!)>=submitted);assert.ok(BigInt(trace.sqliteBeginEnd!)>=BigInt(trace.sqliteBeginStart!));assert.ok(BigInt(trace.moduleComplete!)>=BigInt(trace.sqliteBeginEnd!));assert.ok(BigInt(trace.exitBarrierRelease!)>=submitted+BigInt(LIMITS.exitReleaseMs)*1_000_000n);assert.ok(BigInt(fault.worker.exit!)>=BigInt(trace.exitBarrierRelease!));assert.ok(BigInt(fault.lowerTimerFired!)<BigInt(fault.worker.exit!));
    assert.equal(evidence.actualConnection.busyTimeout.timeout,5000);assert.equal(trace.sqliteBeginCalls,'1');assert.equal(trace.ackAttempts,'1');
    if(mode==='lock'){
     assert.equal(trace.sqliteOutcome,'2','actual SQLite busy failure');assert.equal(trace.ackOk,'2');assert.equal(trace.ackDropped,'0');const acquired=fault.lock!.messages.find(x=>x.kind==='locked')!,released=fault.lock!.messages.find(x=>x.kind==='released')!;assert.ok(BigInt(acquired.at as string)<=submitted);assert.equal(released.reason,'anchored-release');assert.ok(BigInt(released.began as string)>=submitted+BigInt(LIMITS.lockReleaseMs)*1_000_000n);assert.ok(BigInt(trace.sqliteBeginEnd!)<BigInt(released.began as string));assert.ok(BigInt(released.at as string)<BigInt(fault.worker.exit!));
    }else{assert.equal(fault.lock,null);assert.equal(trace.sqliteOutcome,'1');assert.equal(trace.ackOk,'1');assert.equal(trace.ackDropped,'1');assert.ok(BigInt(trace.moduleComplete!)<BigInt(fault.lowerTimerFired!));}
    const found=inspect(path,id);assert.equal(found.row.eventId,BigInt(id));assert.equal(found.row.sourceMessageId,BigInt(id));assert.equal(found.row.state,'held');assert.equal(found.row.confirmationDelivered,false);assert.equal(found.row.phase,mode==='lock'?'processing':'result_recorded');assert.deepEqual(found.row.outcome,mode==='lock'?undefined:{response:TEXT,waits_for_final:false});assert.equal(found.actionReceipt,null);assert.ok(found.errorReceipt?.message_id);assert.equal(found.holds,1);assert.equal(seen.length,before+1);assert.equal(seen.at(-1)?.method,'POST');assert.equal(JSON.parse(seen.at(-1)!.body).content,'ERROR: '+ERROR);assert.deepEqual(reports.slice(reportBefore).map(x=>({code:x.code,detail:x.detail})),[{code:'on_message_error',detail:ERROR}]);
    const beforeDuplicate=watched.journal.length,duplicatePosts=seen.length;await probe.inject(id,`${mode}-duplicate-${round+1}`);assert.deepEqual(watched.journal.slice(beforeDuplicate).map(x=>x.operation),['Admit']);assert.equal(seen.length,duplicatePosts);assert.deepEqual(inspect(path,id),found);assert.equal(reports.length,reportBefore+1);
    outcomes.push({id,mode,state:'held',phase:found.row.phase,confirmed:false,resultPersisted:mode==='ack-loss',actualResult:found.row.outcome??null,actionPosts:0,errorPosts:1,holdNotices:1,duplicateAdmitOnly:true});
    watched.disarm();assert.deepEqual(ownedWorkerUsage(),cleanUsage);await success(fresh,`recovery-${round+1}`);
   }
   assert.equal(invocations.length,13);assert.equal(new Set(invocations.map(x=>x.id)).size,9);assert.equal(seen.length,9);assert.equal(f.queue.locks.activeTargetCount,0);assert.equal(server!.pendingServerRequests('t').length,0);
   const counts:Record<string,number>={};for(const row of watched.journal)counts[row.operation]=(counts[row.operation]??0)+1;assert.deepEqual(counts,plan.journal);assert.equal(watched.journal.length,40);
   probeReport=await probe.stop();assert.equal(probeReport.reason,'requested');assert.ok(probeReport.probes.length>0);assert.ok(probeReport.probes.length<=LIMITS.maxProbes);
   for(const p of probeReport.probes){assert.ok(p.sent&&p.main&&p.ack);assert.equal(p.failure,null);assert.ok(BigInt(p.main)>=BigInt(p.sent));assert.ok(BigInt(p.ack)>=BigInt(p.main));}
   for(const fault of faults){const e=faultEvidence(fault),sql=probeReport.probes.filter((p:any)=>p.main&&BigInt(p.main)>=BigInt(e.trace.sqliteBeginStart!)&&BigInt(p.main)<BigInt(e.trace.sqliteBeginEnd!)),retained=probeReport.probes.filter((p:any)=>p.main&&BigInt(p.main)>=BigInt(e.trace.moduleComplete!)&&BigInt(p.main)<BigInt(fault.worker!.exit!));if(fault.mode==='lock')assert.ok(sql.length>0,'independent progress while actual SQLite wait');assert.ok(retained.length>0,'independent progress while post-SQLite retained');}
   }finally{try{await probe.drain();}catch{cleanupDebt.push('actual handler/injection completion uncertain');}}
  });
  await watch.join();for(const worker of watch.workers){assert.equal(worker.code,0);assert.equal(worker.errors,0);}
  assert.deepEqual(ownedWorkerUsage(),cleanUsage);assert.equal(storeAuthorityEnrolled(path),false);completed=true;
 }catch(error){failure=error;throw error;}
 finally{
  // Cleanup never terminates or substitutes native database workers. Only the
  // exact owned lock/probe receive cleanup; all recorded native handles join.
  for(const fault of faults)if(fault.lock&&!fault.lock.exited)try{await fault.lock.cleanup();}catch{cleanupDebt.push('lock-holder exit uncertain');}
  if(probe)try{await probe.drain();}catch{if(!cleanupDebt.includes('actual handler/injection completion uncertain'))cleanupDebt.push('actual handler/injection completion uncertain');}
  if(probe&&!probe.exited)try{probeReport=await probe.stop();}catch{cleanupDebt.push('probe exit uncertain');}
  if(watch)try{await watch.join();}catch{cleanupDebt.push('native worker exit uncertain');}
  if(server)try{await bounded(server.dispose(),'mock resident dispose');if(server.lifecycleSnapshot().healthy)cleanupDebt.push('resident still healthy');}catch{cleanupDebt.push('resident disposal uncertain');}
  if(watch)try{watch.restore();}catch{cleanupDebt.push('instrumentation restore failed');}
  const ended=String(now()),allProbes=probeReport?.probes??[],workers=watch?.workers??[],sampledMaximum=Object.fromEntries(Object.keys(cleanUsage).map(key=>[key,Math.max(0,...(probe?.samples??[]).map(x=>x.usage[key as keyof typeof cleanUsage]))]));
  const report={plan,started,ended,environment,status:completed&&cleanupDebt.length===0?'passed':'failed',failure:failure instanceof Error?{name:failure.name,message:failure.message}:failure===undefined?null:{name:'unknown'},cleanup:{debt:cleanupDebt,fixtureRetained:cleanupDebt.length!==0,ownedConstructed:workers.length,ownedExited:workers.filter(x=>x.exit!==null).length,finalUsage:ownedWorkerUsage()},invocations,outcomes,faults:faults.map(faultEvidence),journal:watch?.journal??[],workers,workerCounts:{native:workers.filter(x=>x.role==='native').length,lockHolder:workers.filter(x=>x.role==='lock-holder').length,probe:workers.filter(x=>x.role==='probe').length},probes:allProbes,probeSamples:probe?.samples??[],sampledMaximum,probeAccounting:{planned:allProbes.length,sent:allProbes.filter((p:any)=>p.sent!==null).length,main:allProbes.filter((p:any)=>p.main!==null).length,acknowledged:allProbes.filter((p:any)=>p.ack!==null).length,failures:allProbes.filter((p:any)=>p.failure!==null).length},probeTimingMs:{plannedToSent:stats(allProbes.filter((p:any)=>p.sent).map((p:any)=>ms(p.planned,p.sent))),sentToMain:stats(allProbes.filter((p:any)=>p.main).map((p:any)=>ms(p.sent,p.main))),plannedToMain:stats(allProbes.filter((p:any)=>p.main).map((p:any)=>ms(p.planned,p.main))),sentToAck:stats(allProbes.filter((p:any)=>p.ack).map((p:any)=>ms(p.sent,p.ack)))},reports,events:record.events};
  const output=process.env.SQLITE_LOCK_MEASUREMENT_OUTPUT;assert.ok(output,'private report destination required');writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  const profile=JSON.parse(readFileSync(new URL('../../../measurement-profile.json',import.meta.url),'utf8'));writeFileSync(output+'.receipt.json',JSON.stringify({status:report.status,sha256:createHash('sha256').update(readFileSync(output)).digest('hex'),sourceGraphSha256:profile.sourceGraphSha256,profileSha256:profile.profileSha256},null,2)+'\n');
  if(cleanupDebt.length===0){assert.equal(realpathSync(root),root);assert.equal(dirname(root),parent);const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);rmSync(root,{recursive:true});}else writeFileSync(join(root,'cleanup-debt.json'),JSON.stringify(cleanupDebt));
  assert.deepEqual(cleanupDebt,[],'fixture retained because cleanup ownership is uncertain');
 }
});
