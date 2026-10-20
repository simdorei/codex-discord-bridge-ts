import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {httpFixture} from '../../helpers/interaction-worker-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {messageErrorReportTarget,processMessageWithErrorReport as processBoundary,reportMessageProcessingError as reportError} from '../../../src/runtime/message-worker/processing-boundary.ts';
import {MessageWorkerError,messageWorkerErrorInfo} from '../../../src/runtime/message-worker/errors.ts';
import {MessageDatabaseMismatchError,isMessageDatabaseMismatch} from '../../../src/runtime/message-worker/admission.ts';
import {deliverMessageCleanupRefusal as refusal} from '../../../src/runtime/message-worker/cleanup-refusal.ts';
import {ActionExecutionError} from '../../../src/runtime/action-executor/action-error.ts';
import {MirrorCleanupProtectedError} from '../../../src/runtime/cleanup-refusal.ts';
import {cleanupNotificationFailureInfo} from '../../../src/runtime/cleanup-notification-failure.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {receiptHash} from '../../../src/store/delivery-receipt-key.ts';
import {serializeSerdeValue as json} from '../../../src/core/serde-json.ts';
function message(){return decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content:'!mirror_sync',edited_timestamp:null,embeds:[],id:'3',mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0}));}
const protectedError=()=>new ActionExecutionError('MirrorSync',new MirrorCleanupProtectedError(9n,'queued requests'));
async function staged(path:string){await state.admitIngress(path,{ingressId:'message:3',kind:'message',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{version:1n,content:'!mirror_sync'},targetThreadId:null,canonicalOwner:null,now:1});await state.beginIngressExecution(path,'message:3','processing',null,2);}
test('central boundary executes once, reports original target once and joins reporting',async()=>{
 const target=messageErrorReportTarget(message()),work=Object.freeze({id:1}),error=new MessageWorkerError('Action','failed');let processed=0,reports=0;
 await processBoundary(target,work,async w=>{assert.equal(w,work);processed++;throw error;},async(t,e)=>{assert.equal(t,target);assert.equal(e,error);reports++;});assert.equal(processed,1);assert.equal(reports,1);
 await processBoundary(target,work,async()=>{},async()=>{throw Error('no report on success');});
});
test('database mismatch propagates exact original error with zero reporting and forged errors do not gain exemption',async()=>{
 const target=messageErrorReportTarget(message()),error=new MessageDatabaseMismatchError('a','b');assert.equal(isMessageDatabaseMismatch(error),true);
 for(const thrown of [error,new MessageWorkerError('Admission',error)])await assert.rejects(processBoundary(target,0,async()=>{throw thrown;},async()=>{assert.fail('must not report');}),e=>e===error);
 const forged=Object.create(MessageDatabaseMismatchError.prototype);assert.equal(isMessageDatabaseMismatch(forged),false);let reports=0;await processBoundary(target,0,async()=>{throw forged;},async()=>{reports++;});assert.equal(reports,1);
});
test('report target requires original decoded message; native Promise contract avoids hostile thenable hooks',async()=>{
 const target=messageErrorReportTarget(message());let hooks=0;assert.throws(()=>messageErrorReportTarget({...message()}),TypeError);
 await assert.rejects(processBoundary({...target},0,async()=>{},async()=>{}),TypeError);
 await processBoundary(target,0,(()=>({get then(){hooks++;throw Error('hook');}})) as any,async(_t,e)=>{assert.ok(e instanceof TypeError);});assert.equal(hooks,0);
 const error=new Error('report failure');await assert.rejects(processBoundary(target,0,async()=>{throw Error('processing');},async()=>{throw error;}),e=>e===error);
});
test('typed failure taxonomy is passive and known-outcome labels require recorded brand',()=>{
 let hooks=0;const source=new Proxy({}, {get(){hooks++;throw Error('hook');},getPrototypeOf(){hooks++;throw Error('hook');}}),e=new MessageWorkerError('Action',source);assert.equal(messageWorkerErrorInfo(e)!.source,source);assert.equal(hooks,0);
 assert.throws(()=>new MessageWorkerError('KnownOutcomeNotification',{}),TypeError);assert.equal(new MessageWorkerError('Restarting').message,'Codex Discord is restarting. Please retry after restart.');assert.equal(messageWorkerErrorInfo(Object.create(MessageWorkerError.prototype)),null);
});
test('ordinary errors use one durable original error receipt and repeat reporting skips POST',()=>storeFixture(path=>httpFixture(async(http,seen)=>{
 const target=messageErrorReportTarget(message()),log:string[]=[],error=new MessageWorkerError('Action','failed');await reportError(path,http,target,error,(c)=>{log.push(c);});await reportError(path,http,target,error,c=>{log.push(c);});assert.deepEqual(seen,['POST']);assert.deepEqual(log,['on_message_error','on_message_error']);
})));
test('unconfirmed error receipt is logged without resend or detached failure',()=>storeFixture(path=>httpFixture(async(http,seen)=>{
 const key=json([1n,'message/error/v1','inbound-message/3/error-report',0n]);await state.beginDeliveryReceipt(path,key,receiptHash('ERROR: failed'));const log:string[]=[];await reportError(path,http,messageErrorReportTarget(message()),new MessageWorkerError('Action','failed'),c=>{log.push(c);});assert.deepEqual(log,['on_message_error','on_message_error_report_failed']);assert.deepEqual(seen,[]);
})));
test('known pre-delete refusal is stored before delivery with exact conservative flags',()=>storeFixture(path=>httpFixture(async(http,seen)=>{
 await staged(path);assert.equal(await refusal(message(),path,http,protectedError(),()=>3),true);const row=(await state.getIngress(path,'message:3'))!;assert.deepEqual(row.outcome,{kind:'mirror_cleanup_refused',version:1n,sync_completed:false,blocked_room_id:9n,protection_reason:'queued requests',delete_dispatched:false,earlier_changes_possible:true});assert.equal(row.phase,'result_recorded');assert.equal(row.confirmationDelivered,false);assert.deepEqual(seen,['POST']);
})));
test('refusal persistence failure prevents all HTTP and does not classify as known saved notification',()=>storeFixture(path=>httpFixture(async(http,seen)=>{
 await staged(path);const db=await openInitialized(path);try{db.exec("CREATE TRIGGER block_result BEFORE UPDATE OF outcome_json ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture failed result'); END");}finally{db.close();}
 await assert.rejects(refusal(message(),path,http,protectedError(),()=>3),/fixture failed result/);assert.deepEqual(seen,[]);assert.equal((await state.getIngress(path,'message:3'))!.outcome,undefined);
})));
test('failed refusal notification keeps saved outcome and central handler emits no second-key ERROR',()=>storeFixture(path=>httpFixture(async(http,seen)=>{
 await staged(path);const content='Mirror sync stopped.\nroom: 9\nreason: queued requests\nNo deletion was dispatched for this room. Earlier sync changes may have completed.\nPending work is preserved; this request will not retry automatically.';
 await state.beginDeliveryReceipt(path,json([1n,'message/error/v1','inbound-message/3/error-report',0n]),receiptHash(content));let failure:unknown;
 try{await refusal(message(),path,http,protectedError(),()=>3);assert.fail('must fail');}catch(e){failure=e;}
 const info=messageWorkerErrorInfo(failure)!;assert.equal(info.kind,'KnownOutcomeNotification');assert.equal(cleanupNotificationFailureInfo(info.source)!.holdSaved,true);
 const log:string[]=[];await reportError(path,http,messageErrorReportTarget(message()),failure,c=>{log.push(c);});assert.deepEqual(log,['on_message_error']);assert.deepEqual(seen,[]);const row=(await state.getIngress(path,'message:3'))!;assert.equal(row.state,'held');assert.equal((row.outcome as any).delete_dispatched,false);
})));
test('arbitrary errors and invalid typed protection reasons cannot become saved refusals',()=>storeFixture(path=>httpFixture(async(http,seen)=>{
 await staged(path);for(const error of [new Error('queued requests'),new ActionExecutionError('MirrorSync',new MirrorCleanupProtectedError(9n,'not a reason'))])await assert.rejects(refusal(message(),path,http,error,()=>3),e=>messageWorkerErrorInfo(e)?.kind==='Action');assert.deepEqual(seen,[]);assert.equal((await state.getIngress(path,'message:3'))!.outcome,undefined);
})));
