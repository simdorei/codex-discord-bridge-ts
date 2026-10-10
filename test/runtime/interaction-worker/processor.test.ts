import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {ExecutionCustody} from '../../../src/runtime/interaction-worker/execution-custody.ts';
import {createInteractionProcessor, type InteractionBusinessServices} from '../../../src/runtime/interaction-worker/processor.ts';
import {interactionWorkerErrorInfo, interactionErrorDisposition} from '../../../src/runtime/interaction-worker/errors.ts';
import {ComponentWorkerError} from '../../../src/runtime/component-worker/errors.ts';
import {BusyComponentError} from '../../../src/runtime/component-worker/busy-errors.ts';
import {ConfirmationError} from '../../../src/runtime/component-worker/confirmation.ts';
import {ActionExecutionError} from '../../../src/runtime/action-executor/action-error.ts';
import {cleanupRefusalFromActionError, MirrorCleanupProtectedError} from '../../../src/runtime/cleanup-refusal.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {work, stage, httpFixture, edit} from '../../helpers/interaction-worker-fixture.ts';
import type {InboundInteractionWork} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
async function custodyFixture(db: string, custom: string | undefined, run: (w: InboundInteractionWork, c: ExecutionCustody) => Promise<void>) {
  const w = work(db, 3n, new AdmissionGate(), custom); await stage(w); const c = await ExecutionCustody.begin(db, db, w.custodyIngressId, 'Execute', {now: () => 3, report() {}});
  try {await run(w,c);} finally {await c.dispose(); w.admissionPermit!.release();}
}
const unused: InteractionBusinessServices = {async executeWithIngressContext() {throw Error('unexpected action');}, async prepareComponent() {throw Error('unexpected component');}};
test('typed cleanup conversion accepts only exact owned Action/Mirror protection pair and source refusal domain', () => {
  const protectedError = new MirrorCleanupProtectedError(9n, 'queued requests');
  assert.deepEqual(cleanupRefusalFromActionError(new ActionExecutionError('MirrorSync', protectedError)), {room: 9n, reason: 'queued requests'});
  for (const e of [protectedError, new ActionExecutionError('Store', protectedError), new ActionExecutionError('MirrorSync', Object.create(MirrorCleanupProtectedError.prototype)), {kind: 'MirrorSync', source: protectedError}, new ActionExecutionError('MirrorSync', new MirrorCleanupProtectedError(0n, 'queued requests')), new ActionExecutionError('MirrorSync', new MirrorCleanupProtectedError(1n << 63n, 'queued requests')), new ActionExecutionError('MirrorSync', new MirrorCleanupProtectedError(9n, 'unknown reason'))]) assert.equal(cleanupRefusalFromActionError(e), undefined);
});
test('slash planning passes original actor/event/custody context and records precise result before HTTP', async () => {
  await storeFixture(async db => httpFixture(async (http, seen) => custodyFixture(db, undefined, async (w,c) => {
    const calls: unknown[] = [];
    const processor = createInteractionProcessor(db, null as any, http, {...unused, async executeWithIngressContext(...args) {calls.push(args); return {text: 'hello', waitsForFinal: true, ui: null};}});
    assert.equal(await processor(w,c), true); assert.deepEqual(calls, [['Help', {channelId: 1n, userId: 2n, discordMessageId: 3n, autoQueueWhenBusy: false}, 'interaction:3']]);
    assert.deepEqual((await state.getIngress(db, w.custodyIngressId))!.outcome, {kind: 'slash', action_completed: true, waits_for_final: true, response: 'hello'}); assert.deepEqual(seen, ['PATCH']);
  })));
});
test('persisted pre-admission rejection bypasses both business services and records non-execution', async () => {
  await storeFixture(async db => httpFixture(async (http, seen) => {
    const w = work(db, 3n, new AdmissionGate());
    await state.admitIngress(db, {ingressId: w.custodyIngressId, kind: 'interaction', eventId: 3n, applicationId: 4n, channelId: 1n, ownerUserId: 2n, sourceMessageId: null, payload: {work: w.work, request_rejection: 'held fixture'}, targetThreadId: null, canonicalOwner: w.custodyIngressId, now: 1});
    const c = await ExecutionCustody.begin(db,db,w.custodyIngressId,'Execute',{now:()=>3,report(){}});
    try {assert.equal(await createInteractionProcessor(db,null as any,http,unused)(w,c),false); assert.deepEqual((await state.getIngress(db,w.custodyIngressId))!.outcome,{kind:'request_rejected',action_completed:false,control_dispatched:false,error:'held fixture'});assert.deepEqual(seen,['PATCH']);}
    finally {await c.dispose();w.admissionPermit!.release();}
  }));
});
test('known mirror protection persists refusal before notification and never converts plain similar errors', async () => {
  await storeFixture(async db => httpFixture(async (http, seen) => custodyFixture(db,undefined,async(w,c)=>{
    const processor=createInteractionProcessor(db,null as any,http,{...unused,async executeWithIngressContext(){throw new ActionExecutionError('MirrorSync',new MirrorCleanupProtectedError(9n,'queued requests'));}});
    assert.equal(await processor(w,c),false);assert.equal(c.knownCleanupRefusal,true);const outcome=(await state.getIngress(db,w.custodyIngressId))!.outcome as any;assert.equal(outcome.kind,'mirror_cleanup_refused');assert.equal(outcome.delete_dispatched,false);assert.deepEqual(seen,['PATCH']);
  })));
  await storeFixture(async db => custodyFixture(db,undefined,async(w,c)=>{
    const processor=createInteractionProcessor(db,null as any,null as any,{...unused,async executeWithIngressContext(){throw new Error('mirror sync stopped: queued requests');}});
    await assert.rejects(processor(w,c),e=>interactionWorkerErrorInfo(e)?.kind==='Action');assert.equal(c.knownCleanupRefusal,false);assert.equal((await state.getIngress(db,w.custodyIngressId))!.outcome,undefined);
  }));
});
test('component prepares first, then durable completed result precedes lazy notification', async () => {
  await storeFixture(async db=>custodyFixture(db,'codex_approval:t:1',async(w,c)=>{
    let delivered=0;const processor=createInteractionProcessor(db,null as any,null as any,{...unused,async prepareComponent(item,component){assert.equal(item,w);assert.ok('Approval'in component);assert.equal((await state.getIngress(db,w.custodyIngressId))!.outcome,undefined);return {async deliver(){assert.deepEqual((await state.getIngress(db,w.custodyIngressId))!.outcome,{kind:'component',action_completed:true});delivered++;}};}});
    assert.equal(await processor(w,c),false);assert.equal(delivered,1);
  }));
});
test('control preflight refusal records no-dispatch evidence without fabricating success', async()=>{
  await storeFixture(async db=>custodyFixture(db,'codex_busy:'+'a'.repeat(24)+':stop',async(w,c)=>{
    const error=new ComponentWorkerError('Busy',new BusyComponentError('ControlNotDispatched','fixture'));const processor=createInteractionProcessor(db,null as any,null as any,{...unused,async prepareComponent(){throw error;}});
    await assert.rejects(processor(w,c),e=>interactionWorkerErrorInfo(e)?.source===error);assert.deepEqual((await state.getIngress(db,w.custodyIngressId))!.outcome,{kind:'busy_control_preflight_rejected',control_dispatched:false,error:error.message});
  }));
});
test('post-action confirmation recovery failure records known completion while ordinary failure stays unrecorded', async()=>{
  for(const recovery of [true,false])await storeFixture(async db=>custodyFixture(db,'codex_approval:t:1',async(w,c)=>{
    const error=recovery?new ComponentWorkerError('Confirmation',new ConfirmationError('Recovery','fixture')):new ComponentWorkerError('NoPendingRequest');
    const processor=createInteractionProcessor(db,null as any,null as any,{...unused,async prepareComponent(){throw error;}});await assert.rejects(processor(w,c),e=>interactionWorkerErrorInfo(e)?.source===error);
    assert.deepEqual((await state.getIngress(db,w.custodyIngressId))!.outcome,recovery?{kind:'component',action_completed:true,confirmation_error:error.message}:undefined);
  }));
});
test('notification failure after recorded component action remains LogOnly and cannot become action failure', async()=>{
  await storeFixture(async db=>custodyFixture(db,'codex_approval:t:1',async(w,c)=>{
    const processor=createInteractionProcessor(db,null as any,null as any,{...unused,async prepareComponent(){return {async deliver(){throw new ConfirmationError('Delivery','fixture');}};}});
    await assert.rejects(processor(w,c),e=>interactionErrorDisposition(e)==='LogOnly');assert.deepEqual((await state.getIngress(db,w.custodyIngressId))!.outcome,{kind:'component',action_completed:true});
  }));
});
test('callbacks are captured and malformed returned thenables never run arbitrary then hooks', async()=>{
  await storeFixture(async db=>custodyFixture(db,undefined,async(w,c)=>{
    let hooks=0;const services={...unused,executeWithIngressContext(){return {then(){hooks++;}} as any;}};const processor=createInteractionProcessor(db,null as any,null as any,services);services.executeWithIngressContext=()=>{throw Error('changed');};
    await assert.rejects(processor(w,c),e=>interactionWorkerErrorInfo(e)?.kind==='Action'&&String(e).includes('native business Promise'));assert.equal(hooks,0);
  }));
});

test('failed durable slash result write is Custody failure and prevents success HTTP delivery', async () => {
  await storeFixture(async db => httpFixture(async (http, seen) => custodyFixture(db, undefined, async (w,c) => {
    await edit(db, "CREATE TRIGGER block_result BEFORE UPDATE OF outcome_json ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture record'); END");
    const processor = createInteractionProcessor(db, null as any, http, {...unused, async executeWithIngressContext() {return {text: 'must not deliver', waitsForFinal: false, ui: null};}});
    await assert.rejects(processor(w,c), e => interactionWorkerErrorInfo(e)?.kind === 'Custody'); assert.deepEqual(seen, []);
  })));
});
