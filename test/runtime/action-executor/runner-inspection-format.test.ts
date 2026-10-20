import test from 'node:test';
import assert from 'node:assert/strict';
import {serializePrettySerdeValue} from '../../../src/core/serde-json-pretty.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import type {StoredIngress} from '../../../src/store/ingress-read.ts';
import type {StoredQueueJob} from '../../../src/store/queue-read.ts';
import type {StoredPromptIntake} from '../../../src/store/prompt-intake.ts';
import {
 RUNNER_INSPECTION_OUTPUT_BYTES,
 formatSavedRequestMessage,
 formatSavedRequestSummary,
 formatRunnersMessage,
 formatRunnerTargetSummary,
 joinRunnerInspectionMessages,
} from '../../../src/runtime/action-executor/runner-inspection-format.ts';

function record(payload:unknown,overrides:Partial<StoredIngress>={}):StoredIngress {
 return {ingressId:'request',kind:'message',eventId:null,applicationId:null,channelId:42n,ownerUserId:7n,sourceMessageId:null,
  payload,runtimeId:null,state:'held',phase:'claimed',targetThreadId:'t',canonicalOwner:null,ownerKind:null,ownerId:null,
  outcome:undefined,confirmationDelivered:false,holdReason:'review',createdAt:0,updatedAt:0,...overrides};
}

const header='Saved Discord request (read-only)\nrequest_id: request\nstate: held\nphase: claimed\ntarget: t\nreason: review\nThis does not retry, release, or delete the request.\nOriginal payload below omits credential fields only.\noriginal_payload:\n';

test('bounded detail exactly retains pretty Serde key ordering, scalar forms, arrays, nested values and escapes',()=>{
 const controls=Array.from({length:32},(_,i)=>String.fromCharCode(i)).join('');
 const values:unknown[]=[null,true,false,0,-0,1,1e16,1e-6,5e-324,1.7976931348623157e308,
  -9223372036854775808n,18446744073709551615n,'',controls+'"\\/\u2028\u2029😀',[],{},
  {z:[[],{},[true,0,-0,9007199254740993n]],'2':2n,'10':10n,'\u{10000}':'supplementary','\ue000':'BMP'},
  // Exercise a surrogate pair spanning the serializer's usual chunk boundary.
  'x'.repeat(2047)+'😀'+controls+'y'.repeat(2048)];
 const nullPrototype=Object.create(null) as Record<string,unknown>;nullPrototype.__proto__={value:1n};nullPrototype.a=[];values.push(nullPrototype);
 for(const value of values)assert.equal(formatSavedRequestMessage(record(value)),header+serializePrettySerdeValue(value));
});

test('field-name-only credential redaction preserves literal prompt contents and exact bigint without mutating input',()=>{
 const payload={prompt:'literal password token text stays unchanged\r\nnext',id:9007199254740993n,
  Access_Token:'secret-marker',nested:[{otp_code:'otp-marker',keep:'safe',tokenizer:'keep-tokenizer',SECRET:'hidden'}],
  normal:{authorization:'auth-marker',value:1n},'set-cookie':{deep:'hidden'},'client_secret':'hidden'};
 const before=serializeSerdeValue(payload),redacted={prompt:payload.prompt,id:payload.id,nested:[{keep:'safe',tokenizer:'keep-tokenizer'}],normal:{value:1n}};
 assert.equal(formatSavedRequestMessage(record(payload)),header+serializePrettySerdeValue(redacted));
 assert.equal(serializeSerdeValue(payload),before);
 for(const value of ['token','interactiontoken','accesstoken','refreshtoken','idtoken','sessiontoken','authorization','proxyauthorization','cookie','setcookie','password','passwd','apikey','clientsecret','secret','credentials','credential','otp','otpcode']){
  assert.equal(formatSavedRequestMessage(record({[value]:'hidden',keep:'safe'})),header+'{\n  "keep": "safe"\n}');
 }
});

test('detail preserves owned-value validation errors even for invalid fields that would be redacted',()=>{
 let hooks=0;const accessor={get token(){hooks++;return 'secret';}},cycle:Record<string,unknown>={};cycle.self=cycle;
 const hidden=Object.create(null);Object.defineProperty(hidden,'hidden',{value:1n});
 const symbol={value:1n,[Symbol('key')]:true};const sparse=new Array(1);
 const invalid=[undefined,Symbol('value'),()=>0,NaN,Infinity,-Infinity,1n<<64n,-(1n<<63n)-1n,'\ud800',new Date(0),accessor,cycle,hidden,symbol,sparse,{token:undefined}];
 for(const value of invalid)assert.throws(()=>formatSavedRequestMessage(record(value)),{name:'TypeError',message:'Expected decoded Serde Value'});
 assert.equal(hooks,0);
});

test('saved summary retains exact cancellation, completion, hold and cleanup-refusal wording',()=>{
 const outcome={kind:'mirror_cleanup_refused',version:1n,sync_completed:false,delete_dispatched:false,earlier_changes_possible:true,blocked_room_id:99n,protection_reason:'queued requests'};
 const records=[record({prompt:'never show'},{ingressId:'held',targetThreadId:'line1\nline2',holdReason:'why\rnext'}),
  record({}, {ingressId:'cancelled',state:'completed',phase:'cancelled',holdReason:''}),
  record({}, {ingressId:'completed',state:'completed',holdReason:'',targetThreadId:null}),
  record({}, {ingressId:'refused',outcome,holdReason:''})];
 assert.equal(formatSavedRequestSummary(records),'Your saved requests needing attention (latest 20):\nheld | status: saved; manual review required | target: line1 line2 | reason: why next\ncancelled | status: cancelled; original confirmation pending | target: t | reason: request cancelled by its original sender; no execution retry\ncompleted | status: execution completed; confirmation pending | target: not yet known | reason: confirmation delivery not recorded\nrefused | status: sync stopped; notification unconfirmed | reason: Mirror sync stopped: room 99 protected by queued requests; notification confirmation not recorded. No deletion dispatched for this room; earlier changes may have completed. No automatic retry.\nInspect: !runners <request_id> (original user and channel only).');
 assert.equal(formatSavedRequestSummary([]),'Your saved requests needing attention (latest 20):\nnone\nInspect: !runners <request_id> (original user and channel only).');
 assert.equal(formatSavedRequestMessage(record({}, {outcome,holdReason:''})),
  'Saved Discord request (read-only)\nrequest_id: request\nstate: held\nphase: claimed\ntarget: t\nreason: \nknown_outcome: Mirror sync stopped.\nroom: 99\nreason: queued requests\nNo deletion was dispatched for this room. Earlier sync changes may have completed.\nPending work is preserved; this request will not retry automatically.\nnotification_confirmed: false\nThis does not retry, release, or delete the request.\nOriginal payload below omits credential fields only.\noriginal_payload:\n{}');
});

function job(state:StoredQueueJob['state']):StoredQueueJob {
 return {jobId:state,targetThreadId:'t',channelId:42n,ownerUserId:7n,discordMessageId:null,appServerGeneration:1n,
  executionGeneration:null,turnObservationGeneration:null,goalWaiting:false,prompt:'private',queued:false,ackSent:false,state,
  attemptCount:0n,turnId:null,baselineTurnIds:[],lastError:'',createdAt:0,updatedAt:0};
}
function intake(lastError:string):StoredPromptIntake {
 return {jobId:'i',targetThreadId:'t',channelId:42n,ownerUserId:7n,discordMessageId:null,rawPrompt:'private',autoQueueWhenBusy:false,
  requireCurrentMirror:false,attemptCount:0n,lastError,retryAfter:0,claimToken:null,claimExpiresAt:0,createdAt:0,updatedAt:0};
}

test('global and target formatters retain exact wording and bigint counts',()=>{
 const snapshot={jobs:[job('Pending'),job('Starting'),job('Running'),job('Quarantined')],pending:9007199254740993n,unknown:2n,blocked:3n,intakes:[intake(''),intake('backoff')],held:['p: review original','i: separate']};
 assert.equal(formatRunnersMessage(snapshot),'Codex runners\nexecution_held (explicit recovery required): p: review original\ni: separate\npending: 1\nstarting: 1\nrunning: 1\nquarantined: 1\nfinal_pending: 9007199254740993\nsends_unconfirmed: 2 (not automatically resent)\nsends_rejected: 3 (requires correction; no automatic retry)\nrecoverable_intakes: 2\nintake_backoff: 1');
 assert.equal(formatRunnersMessage({...snapshot,jobs:[],held:[],intakes:[],pending:0n,unknown:0n,blocked:0n}),
  'Codex runners\nexecution_held (explicit recovery required): none\npending: 0\nstarting: 0\nrunning: 0\nquarantined: 0\nfinal_pending: 0\nsends_unconfirmed: 0 (not automatically resent)\nsends_rejected: 0 (requires correction; no automatic retry)\nrecoverable_intakes: 0\nintake_backoff: 0');
 assert.equal(formatRunnerTargetSummary([9007199254740993n,2n,3n,4n,5n,6n,7n],{target:'t',source:'selection',owned:'owned_active_turn: turn\nconnection_generation: 9007199254740993'}),
  'Current target work (stored counts and resident ownership check; no remote probe)\ntarget: t\nsource: selection\nowned_active_turn: turn\nconnection_generation: 9007199254740993\nqueued: 9007199254740993\nstarting: 2\nrunning_records: 3\nintake: 4\nheld_ingress: 5\nunowned_ingress: 6\nquarantined_records: 7');
});

test('detail succeeds at exactly one MiB and rejects the first byte beyond it',()=>{
 const baseline=formatSavedRequestMessage(record({prompt:''})),length=RUNNER_INSPECTION_OUTPUT_BYTES-Buffer.byteLength(baseline);
 const exact=formatSavedRequestMessage(record({prompt:'x'.repeat(length)}));assert.equal(Buffer.byteLength(exact),RUNNER_INSPECTION_OUTPUT_BYTES);
 assert.throws(()=>formatSavedRequestMessage(record({prompt:'x'.repeat(length+1)})),{name:'RangeError',message:'Runner inspection output exceeds 1 MiB budget'});
});

test('UTF-8 byte cap counts multibyte text instead of JavaScript string length',()=>{
 const baseline=formatSavedRequestMessage(record({prompt:''})),remaining=RUNNER_INSPECTION_OUTPUT_BYTES-Buffer.byteLength(baseline);
 const text='😀'.repeat(Math.floor(remaining/4))+'x'.repeat(remaining%4);
 assert.equal(Buffer.byteLength(formatSavedRequestMessage(record({prompt:text}))),RUNNER_INSPECTION_OUTPUT_BYTES);
 assert.throws(()=>formatSavedRequestMessage(record({prompt:text+'x'})),RangeError);
});

test('escaped output stops during bounded accumulation without serializing the whole input string',()=>{
 const prompt='\0'.repeat(200_000),original=JSON.stringify;let serialized=0,maxChunk=0;
 JSON.stringify=((value:unknown,...args:unknown[])=>{
  if(typeof value==='string'){serialized+=value.length;maxChunk=Math.max(maxChunk,value.length);}
  return Reflect.apply(original,JSON,[value,...args]);
 }) as typeof JSON.stringify;
 try{assert.throws(()=>formatSavedRequestMessage(record({prompt})),RangeError);}finally{JSON.stringify=original;}
 assert.ok(serialized<prompt.length,`${serialized} characters serialized before the cap`);assert.ok(maxChunk<=2048,`${maxChunk} character maximum serialization fragment`);
});

test('small compact input cannot evade the output cap through nested pretty indentation',()=>{
 let payload:unknown={};for(let i=0;i<800;i++)payload={nested:payload};
 assert.ok(Buffer.byteLength(serializeSerdeValue(payload))<16_384);
 assert.throws(()=>formatSavedRequestMessage(record(payload)),{name:'RangeError',message:'Runner inspection output exceeds 1 MiB budget'});
});

test('summary, held display, target context and final aggregate each enforce the same output cap',()=>{
 const huge='x'.repeat(RUNNER_INSPECTION_OUTPUT_BYTES);
 assert.throws(()=>formatSavedRequestSummary([record({}, {holdReason:huge})]),RangeError);
 assert.throws(()=>formatRunnersMessage({jobs:[],pending:0n,unknown:0n,blocked:0n,intakes:[],held:[huge]}),RangeError);
 assert.throws(()=>formatRunnerTargetSummary([0n,0n,0n,0n,0n,0n,0n],{target:'t',source:'s',owned:huge}),RangeError);
 assert.equal(joinRunnerInspectionMessages(['a','b','c']),'a\n\nb\n\nc');
 assert.equal(joinRunnerInspectionMessages([huge]).length,RUNNER_INSPECTION_OUTPUT_BYTES);
 assert.throws(()=>joinRunnerInspectionMessages([huge,'x'],''),RangeError);
 assert.throws(()=>joinRunnerInspectionMessages(['a'.repeat(RUNNER_INSPECTION_OUTPUT_BYTES/2),'b'.repeat(RUNNER_INSPECTION_OUTPUT_BYTES/2)]),RangeError);
});
