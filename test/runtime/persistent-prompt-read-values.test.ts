import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boundedSerdeByteCount} from '../../src/core/serde-byte-count.ts';
import {capturePersistentPromptReadRequest as request,capturePersistentPromptReadSuccess as success,
 PERSISTENT_PROMPT_READ_VALUE_LIMITS as limits,type PersistentPromptReadJob} from '../../src/runtime/persistent-prompt-read-values.ts';

const min=-(1n<<63n),max=(1n<<63n)-1n;
const jobsRequest={op:'all-jobs'};
function job():PersistentPromptReadJob{return {jobId:'',targetThreadId:'\0',channelId:min,ownerUserId:null,
 discordMessageId:max,appServerGeneration:min,executionGeneration:max,turnObservationGeneration:null,
 goalWaiting:false,prompt:'🙂\0',queued:true,ackSent:false,state:'Running',attemptCount:min,
 turnId:null,baselineTurnIds:['','\0','🙂'],lastError:'',createdAt:-0,updatedAt:1.25};}
const acceptJobs=(value:unknown)=>success(jobsRequest,{op:'all-jobs',value});

test('three exact operation shapes and matching successes survive owned clone round trips',()=>{
 const cases=[
  [{op:'observed-completion',thread:'',turn:'\0'},{op:'observed-completion',value:false}],
  [jobsRequest,{op:'all-jobs',value:[job()]}],
  [{op:'channel-mapping',channel:min},{op:'channel-mapping',value:'\0🙂'}],
 ] as const;
 for(const [input,result] of cases){const captured=request(input),output=success(captured,result);assert.deepEqual(output,success(structuredClone(captured),structuredClone(output)));assert.ok(Object.isFrozen(captured));assert.ok(Object.isFrozen(output));}
 const result=acceptJobs([job()]);assert.equal(result.op,'all-jobs');if(result.op==='all-jobs'){assert.ok(Object.is(result.value[0]!.createdAt,-0));assert.equal(result.value[0]!.appServerGeneration,min);}
 assert.deepEqual(request(Object.assign(Object.create(null),jobsRequest)),jobsRequest);
 const nullRow=Object.assign(Object.create(null),job());assert.equal(success(Object.assign(Object.create(null),jobsRequest),Object.assign(Object.create(null),{op:'all-jobs',value:[nullRow]})).op,'all-jobs');
});
test('caller mutation cannot alter immutable request, job, or nested baseline copies',()=>{
 const input={op:'observed-completion',thread:'original',turn:'turn'},captured=request(input);input.thread='changed';assert.equal(captured.op==='observed-completion'&&captured.thread,'original');
 const original={...job(),baselineTurnIds:['original']},output=acceptJobs([original]);original.baselineTurnIds[0]='changed';original.prompt='changed';
 if(output.op!=='all-jobs')assert.fail();assert.equal(output.value[0]!.baselineTurnIds[0],'original');assert.equal(output.value[0]!.prompt,'🙂\0');assert.ok(Object.isFrozen(output.value));assert.ok(Object.isFrozen(output.value[0]));assert.ok(Object.isFrozen(output.value[0]!.baselineTurnIds));
});
test('request rejects unknown fields, discriminants, wrong integers, and error envelopes',()=>{
 for(const value of [null,[],{}, {op:'other'}, {op:'all-jobs',path:'/unused'}, {op:'all-jobs',timeout:5000},
  {op:'observed-completion',thread:'a'}, {op:'observed-completion',thread:1,turn:'b'},
  ...[undefined,1,1.5,'1',min-1n,max+1n].map(channel=>({op:'channel-mapping',channel}))])assert.throws(()=>request(value),TypeError);
 for(const op of ['all-jobs','channel-mapping'])assert.throws(()=>success({op:'observed-completion',thread:'a',turn:'b'},{op,value:false}),TypeError);
 for(const value of [{op:'all-jobs',error:'failure'}, {op:'all-jobs',value:[],extra:0}, {op:'all-jobs',value:undefined}])assert.throws(()=>success(jobsRequest,value),TypeError);
});
test('observed identities preserve exact UTF-8 boundaries and scalar text semantics',()=>{
 for(const thread of ['a'.repeat(limits.observedIdentityBytes),'🙂'.repeat(limits.observedIdentityBytes/4),'\0'.repeat(limits.observedIdentityBytes)])assert.equal(request({op:'observed-completion',thread,turn:''}).op,'observed-completion');
 for(const thread of ['a'.repeat(limits.observedIdentityBytes+1),'🙂'.repeat(limits.observedIdentityBytes/4)+'a','\ud800','\udfff'])assert.throws(()=>request({op:'observed-completion',thread,turn:''}),TypeError);
 for(const value of [0,1n,'true',null,{},[]])assert.throws(()=>success({op:'observed-completion',thread:'',turn:''},{op:'observed-completion',value}),TypeError);
});
test('mapping retains nullable and zero no-open result, signed channels, and unrestricted original text',()=>{
 for(const channel of [null,0n,min,max])assert.deepEqual(success({op:'channel-mapping',channel},{op:'channel-mapping',value:null}),{op:'channel-mapping',value:null});
 for(const channel of [null,0n])assert.throws(()=>success({op:'channel-mapping',channel},{op:'channel-mapping',value:''}),TypeError);
 for(const value of ['','\0','🙂','x'.repeat(5000)])assert.equal(success({op:'channel-mapping',channel:-1n},{op:'channel-mapping',value}).op,'channel-mapping');
 for(const value of [1,1n,{},[],true,'\ud800'])assert.throws(()=>success({op:'channel-mapping',channel:1n},{op:'channel-mapping',value}),TypeError);
});
test('every job field is required and has the original native successful-value type',()=>{
 const source=job();
 for(const key of Object.keys(source)){const missing={...source} as Record<string,unknown>;delete missing[key];assert.throws(()=>acceptJobs([missing]),TypeError);}
 const wrong:Record<string,unknown[]>={jobId:[null,1,'\ud800'],targetThreadId:[null,1],channelId:[0,max+1n,min-1n],ownerUserId:[0,max+1n],discordMessageId:[false,min-1n],
  appServerGeneration:[0,max+1n],executionGeneration:[0,min-1n],turnObservationGeneration:[0,max+1n],goalWaiting:[0,null],prompt:[null,'\udfff'],queued:[0],ackSent:[1],
  state:['running','Unknown',null],attemptCount:[0,max+1n],turnId:[0,'\ud800'],baselineTurnIds:[null,[0],['\ud800']],lastError:[null],createdAt:[0n,NaN,Infinity,-Infinity],updatedAt:[null,NaN,Infinity]};
 for(const [key,values] of Object.entries(wrong))for(const value of values)assert.throws(()=>acceptJobs([{...source,[key]:value}]),TypeError);
 assert.throws(()=>acceptJobs([{...source,extra:1}]),TypeError);
 for(const state of ['Pending','Starting','Running','Quarantined'] as const)assert.equal(acceptJobs([{...source,state}]).op,'all-jobs');
});
test('accessors, proxies, symbols, prototypes, sparse arrays and cycles never become values',()=>{
 let calls=0;const accessor=Object.defineProperty({},'op',{enumerable:true,get(){calls++;return 'all-jobs';}});
 for(const input of [accessor,new Proxy(jobsRequest,{get(){calls++;return 'all-jobs';}}),Object.assign(Object.create({}),jobsRequest),{...jobsRequest,[Symbol()]:1}])assert.throws(()=>request(input),TypeError);
 const successGetter=Object.defineProperty({op:'all-jobs'},'value',{enumerable:true,get(){calls++;return [];}});
 assert.throws(()=>success(accessor,successGetter),TypeError);
 assert.throws(()=>success(jobsRequest,successGetter),TypeError);
 const getter={...job()};Object.defineProperty(getter,'prompt',{enumerable:true,get(){calls++;return '';}});assert.throws(()=>acceptJobs([getter]),TypeError);
 const hole=Array(1),extra=Object.assign([job()],{extra:1}),cycle:unknown[]=[];cycle.push(cycle);
 for(const rows of [hole,extra,cycle,new Proxy([job()],{}),[{...job(),baselineTurnIds:Array(1)}]])assert.throws(()=>acceptJobs(rows),TypeError);
 const nonenumerable={...job()};Object.defineProperty(nonenumerable,'prompt',{value:'x',enumerable:false});assert.throws(()=>acceptJobs([nonenumerable]),TypeError);
 assert.equal(calls,0);
});
test('allJobs preserves order, all rows and all baseline items without invented count limits',()=>{
 const rows=Array.from({length:1300},(_,i)=>({...job(),jobId:String(i),baselineTurnIds:Array.from({length:20},(_,n)=>String(n))}));
 const result=acceptJobs(rows);if(result.op!=='all-jobs')assert.fail();assert.equal(result.value.length,1300);assert.equal(result.value[1299]!.jobId,'1299');assert.deepEqual(result.value[1]!.baselineTurnIds,rows[1]!.baselineTurnIds);
});
test('allJobs accepts its exact original 16 MiB native envelope and refuses one byte over',()=>{
 const row={...job(),prompt:''},base=boundedSerdeByteCount({ok:true,value:[row]},limits.nativeResultEnvelopeBytes);assert.notEqual(base,null);
 row.prompt='a'.repeat(limits.nativeResultEnvelopeBytes-base!);
 assert.equal(boundedSerdeByteCount({ok:true,value:[row]},limits.nativeResultEnvelopeBytes),limits.nativeResultEnvelopeBytes);
 assert.equal(acceptJobs([row]).op,'all-jobs');row.prompt+='a';assert.throws(()=>acceptJobs([row]),TypeError);
});
test('mapping accepts its exact original wrapper budget separately from the new operation header',()=>{
 const channel=max,base=boundedSerdeByteCount({ok:true,operation:'MirrorTarget',value:{channel,target:''}},limits.nativeResultEnvelopeBytes);assert.notEqual(base,null);
 const value='a'.repeat(limits.nativeResultEnvelopeBytes-base!);
 assert.equal(boundedSerdeByteCount({ok:true,operation:'MirrorTarget',value:{channel,target:value}},limits.nativeResultEnvelopeBytes),limits.nativeResultEnvelopeBytes);
 assert.equal(success({op:'channel-mapping',channel},{op:'channel-mapping',value}).op,'channel-mapping');
 assert.throws(()=>success({op:'channel-mapping',channel},{op:'channel-mapping',value:value+'a'}),TypeError);
});
