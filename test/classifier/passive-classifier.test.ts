import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../../src/classifier/core.ts';
import { findRegistryPin } from '../../src/classifier/registry.ts';
import type { DiagnosticContext, RegistryKey } from '../../src/classifier/schema.ts';
import { DrainGateError } from '../../src/admission/owned-key.ts';
import { InvalidClassifierArgumentError, InvalidThreadStateError } from '../../src/restart/thread-state.ts';
import { ForkHandoffCycleError } from '../../src/store/fork-canonical-target.ts';
import { DeadGenerationTargetHeldError } from '../../src/store/fork-completed-target.ts';
import { ForkHandoffTargetMovedError, ForkHandoffUnresolvedError } from '../../src/store/fork-handoff-admission.ts';
import { InvalidQueueStateError as QueueAttachGoalInvalidQueueStateError, SystemTimeError } from '../../src/store/queue-attach-goal.ts';
import { MirrorMappingChangedError } from '../../src/store/queue-enqueue.ts';
import { InvalidQueueStateError as QueueReadInvalidQueueStateError, QueueJobNotFoundError } from '../../src/store/queue-read.ts';
import { StoreIntegrityError, UnsupportedVersionError } from '../../src/store/schema-assembly.ts';

describe('passive error classifier', () => {
  const registryCases: readonly [string, unknown, RegistryKey, Record<string, unknown>][] = [
    ['DrainGateError', new DrainGateError('InvalidKey'), 'Admission.DrainGateError', { kind: 'InvalidKey' }],
    ['InvalidThreadStateError', new InvalidThreadStateError('t1', 'stopped'), 'Restart.InvalidThreadStateError', { threadId: 't1', thread_id: 't1', reason: 'stopped' }],
    ['InvalidClassifierArgumentError', new InvalidClassifierArgumentError('arg1', 'bad'), 'Restart.InvalidClassifierArgumentError', { argument: 'arg1' }],
    ['StoreIntegrityError', new StoreIntegrityError('corrupt'), 'Store.StoreIntegrityError', { kind: 'Integrity', result: 'corrupt' }],
    ['UnsupportedVersionError', new UnsupportedVersionError(4n, 2n), 'Store.UnsupportedVersionError', { kind: 'UnsupportedVersion', found: 4n, supported: 2n }],
    ['QueueJobNotFoundError', new QueueJobNotFoundError('job-1'), 'Store.QueueJobNotFoundError', { kind: 'QueueJobNotFound' }],
    ['QueueRead.InvalidQueueStateError', new QueueReadInvalidQueueStateError('stale'), 'Store.QueueRead.InvalidQueueStateError', { kind: 'InvalidQueueState' }],
    ['QueueAttachGoal.InvalidQueueStateError', new QueueAttachGoalInvalidQueueStateError('stale'), 'Store.QueueAttachGoal.InvalidQueueStateError', { kind: 'InvalidQueueState' }],
    ['SystemTimeError', new SystemTimeError('skew'), 'Store.SystemTimeError', { kind: 'SystemTime' }],
    ['MirrorMappingChangedError', new MirrorMappingChangedError(123n, 't-exp', 't-act'), 'Store.MirrorMappingChangedError', { kind: 'MirrorMappingChanged', discordChannelId: 123n, expectedTargetThreadId: 't-exp', actualTargetThreadId: 't-act' }],
    ['ForkHandoffUnresolvedError', new ForkHandoffUnresolvedError('tgt-1', 'err-msg'), 'Store.ForkHandoffUnresolvedError', { kind: 'ForkHandoffUnresolved', targetThreadId: 'tgt-1', lastError: 'err-msg' }],
    ['ForkHandoffTargetMovedError', new ForkHandoffTargetMovedError('src-1', 'tgt-2'), 'Store.ForkHandoffTargetMovedError', { kind: 'ForkHandoffTargetMoved', sourceThreadId: 'src-1', targetThreadId: 'tgt-2' }],
    ['ForkHandoffCycleError', new ForkHandoffCycleError('src-c'), 'Store.ForkHandoffCycleError', { kind: 'ForkHandoffCycle', sourceThreadId: 'src-c' }],
    ['DeadGenerationTargetHeldError', new DeadGenerationTargetHeldError('tgt-d'), 'Store.DeadGenerationTargetHeldError', { kind: 'DeadGenerationTargetHeld', targetThreadId: 'tgt-d' }],
  ];

  it('classifies all 14 exact registry identities with pure frozen fields and unmodified references', () => {
    for (const [name, err, expectedKey, expectedFields] of registryCases) {
      const ctx: DiagnosticContext = { caller: name };
      const res = classifyError(err, ctx);
      assert.strictEqual(res.classification.status, 'classified');
      if (res.classification.status === 'classified') {
        assert.strictEqual(res.classification.matchKey, expectedKey);
        const expectedRecord = Object.assign(Object.create(null), expectedFields);
        assert.deepStrictEqual(res.classification.fields, expectedRecord);
        assert.strictEqual(Object.getPrototypeOf(res.classification.fields), null);
        assert.ok(Object.isFrozen(res.classification.fields));
        for (const desc of Object.values(Object.getOwnPropertyDescriptors(res.classification.fields))) {
          assert.strictEqual(desc.writable, false);
          assert.strictEqual(desc.configurable, false);
          assert.strictEqual(desc.enumerable, true);
        }
      }
      assert.strictEqual(res.raw, err);
      assert.strictEqual(res.context, ctx);
      assert.strictEqual(Object.isFrozen(err), false);
      assert.strictEqual(Object.isFrozen(ctx), false);
      assert.strictEqual(Object.isFrozen(Object.getPrototypeOf(err)), false);
    }
  });

  it('classifies nullable fields with null values', () => {
    const mNull = new MirrorMappingChangedError(456n, 't-exp', null);
    const resM = classifyError(mNull, {});
    assert.strictEqual(resM.classification.status, 'classified');
    if (resM.classification.status === 'classified') {
      assert.strictEqual(resM.classification.fields['actualTargetThreadId'], null);
    }
    const fNull = new ForkHandoffUnresolvedError('tgt-2', null);
    const resF = classifyError(fNull, {});
    assert.strictEqual(resF.classification.status, 'classified');
    if (resF.classification.status === 'classified') {
      assert.strictEqual(resF.classification.fields['lastError'], null);
    }
  });

  it('verifies distinct QueueRead vs QueueAttachGoal classes', () => {
    const readErr = new QueueReadInvalidQueueStateError('read-state');
    const attachErr = new QueueAttachGoalInvalidQueueStateError('attach-state');
    assert.notStrictEqual(Object.getPrototypeOf(readErr), Object.getPrototypeOf(attachErr));

    const resRead = classifyError(readErr, { scope: 'read' });
    const resAttach = classifyError(attachErr, { scope: 'attach' });
    assert.strictEqual(resRead.classification.status, 'classified');
    assert.strictEqual(resAttach.classification.status, 'classified');
    if (resRead.classification.status === 'classified' && resAttach.classification.status === 'classified') {
      assert.strictEqual(resRead.classification.matchKey, 'Store.QueueRead.InvalidQueueStateError');
      assert.strictEqual(resAttach.classification.matchKey, 'Store.QueueAttachGoal.InvalidQueueStateError');
    }
  });

  it('passive-forgery proof: Object.create with registered prototype and safe own data descriptors', () => {
    const forgery = Object.create(DrainGateError.prototype, {      kind: { value: 'Sealed', writable: false, enumerable: true, configurable: false },
    });
    const res = classifyError(forgery, { proof: 'passive-forgery' });
    assert.strictEqual(res.classification.status, 'classified');
    if (res.classification.status === 'classified') {
      assert.strictEqual(res.classification.matchKey, 'Admission.DrainGateError');
      assert.strictEqual(res.classification.fields['kind'], 'Sealed');
    }
  });

  it('validates all DrainGate literals and rejects wrong literals and types', () => {
    const allowed = ['InvalidKey', 'Sealed', 'FenceMismatch', 'LockPoisoned', 'DisposedHandle'] as const;
    for (const lit of allowed) {
      const res = classifyError(new DrainGateError(lit), {});
      assert.strictEqual(res.classification.status, 'classified');
    }
    const wrongLiteral = Object.create(DrainGateError.prototype, {      kind: { value: 'UnexpectedLiteral', enumerable: true, writable: false, configurable: false },
    });
    assert.strictEqual(classifyError(wrongLiteral, {}).classification.status, 'unknown');

    const wrongType = Object.create(DrainGateError.prototype, {      kind: { value: 999, enumerable: true, writable: false, configurable: false },
    });
    assert.strictEqual(classifyError(wrongType, {}).classification.status, 'unknown');
  });

  it('rejects active and revoked Proxies with 0 trap calls via pre-barrier', () => {
    let trapCalls = 0;
    const hostile = new Proxy(new DrainGateError('Sealed'), {
      get() { trapCalls++; throw new Error('trap get'); },
      getPrototypeOf() { trapCalls++; throw new Error('trap getPrototypeOf'); },
      getOwnPropertyDescriptor() { trapCalls++; throw new Error('trap getOwnPropertyDescriptor'); },
      has() { trapCalls++; throw new Error('trap has'); },
    });
    assert.strictEqual(classifyError(hostile, {}).classification.status, 'unknown');
    assert.strictEqual(trapCalls, 0);

    const { proxy: revProxy, revoke } = Proxy.revocable(new DrainGateError('Sealed'), {});
    revoke();
    assert.strictEqual(classifyError(revProxy, {}).classification.status, 'unknown');
  });

  it('ensures zero getter calls, zero coercion calls, and zero cause/stack/name inspection', () => {
    let getterCalls = 0;
    const getterErr = Object.create(DrainGateError.prototype);
    Object.defineProperty(getterErr, 'kind', { get() { getterCalls++; return 'Sealed'; }, enumerable: true, configurable: true });
    assert.strictEqual(classifyError(getterErr, {}).classification.status, 'unknown');
    assert.strictEqual(getterCalls, 0);

    let coercionCalls = 0;
    const coercionErr = Object.create(DrainGateError.prototype, {
      kind: { value: 'Sealed', enumerable: true, writable: false, configurable: false },
      toString: { value() { coercionCalls++; return 'str'; } },
      valueOf: { value() { coercionCalls++; return 1; } },
      [Symbol.toPrimitive]: { value() { coercionCalls++; return 'prim'; } },
    });
    assert.strictEqual(classifyError(coercionErr, {}).classification.status, 'classified');
    assert.strictEqual(coercionCalls, 0);

    const hostilePropsErr = Object.create(DrainGateError.prototype, {
      kind: { value: 'Sealed', enumerable: true, writable: false, configurable: false },
      cause: { get() { throw new Error('cause inspected'); } },
      stack: { get() { throw new Error('stack inspected'); } },
      name: { get() { throw new Error('name inspected'); } },
    });
    assert.strictEqual(classifyError(hostilePropsErr, {}).classification.status, 'classified');
  });

  it('rejects subclasses and deeper prototype chains as unknown', () => {
    class SubDrainGateError extends DrainGateError {}
    assert.strictEqual(classifyError(new SubDrainGateError('Sealed'), {}).classification.status, 'unknown');

    const deeper = Object.create(new DrainGateError('Sealed'));
    assert.strictEqual(classifyError(deeper, {}).classification.status, 'unknown');
  });

  it('treats null and primitives as opaque unknown', () => {
    const prims: readonly unknown[] = [null, undefined, 42, 'msg', true, Symbol('s'), 99n];
    for (const val of prims) {
      const res = classifyError(val, { val });
      assert.strictEqual(res.classification.status, 'unknown');
      assert.strictEqual(res.raw, val);
    }
  });

  it('preserves raw error and diagnostic context references and distinguishes contexts', () => {
    const err = new DrainGateError('FenceMismatch');
    const ctxA: DiagnosticContext = { key: 'ctx-A' };
    const ctxB: DiagnosticContext = { key: 'ctx-B' };
    const resA = classifyError(err, ctxA);
    const resB = classifyError(err, ctxB);

    assert.strictEqual(resA.raw, err);
    assert.strictEqual(resB.raw, err);
    assert.strictEqual(resA.context, ctxA);
    assert.strictEqual(resB.context, ctxB);
    assert.notStrictEqual(resA.context, resB.context);
  });

  it('verifies registry pin records, maps, validators, and literal arrays are frozen with no mutations', () => {
    const pin = findRegistryPin(DrainGateError.prototype);
    assert.ok(pin !== undefined);
    if (pin !== undefined) {
      assert.ok(Object.isFrozen(pin));
      assert.ok(Object.isFrozen(pin.fields));
      for (const validator of Object.values(pin.fields)) {
        assert.ok(Object.isFrozen(validator));
        if (validator.allowedLiterals !== undefined) {
          assert.ok(Object.isFrozen(validator.allowedLiterals));
        }
      }
    }
    assert.strictEqual(findRegistryPin({}), undefined);
    assert.strictEqual(findRegistryPin(null as unknown as object), undefined);
  });

  it('inherited descriptor get/set poisoning regression: zero accessor execution on Object.hasOwn data gate', () => {
    const origGet = Object.getOwnPropertyDescriptor(Object.prototype, 'get');
    const origSet = Object.getOwnPropertyDescriptor(Object.prototype, 'set');
    let poisonCount = 0;
    const poisonDesc: PropertyDescriptor = Object.assign(Object.create(null), {
      get() { poisonCount++; throw new Error('POISON_ACCESSOR'); },
      configurable: true, enumerable: false,
    });

    const testErr = Object.create(DrainGateError.prototype);
    Object.defineProperty(testErr, 'kind', { get() { return 'InvalidKey'; }, configurable: true, enumerable: true });
    const testCtx: DiagnosticContext = Object.create(null);
    let runResult: unknown;
    let runError: unknown;

    try {
      Object.defineProperty(Object.prototype, 'get', poisonDesc);
      Object.defineProperty(Object.prototype, 'set', poisonDesc);
      runResult = classifyError(testErr, testCtx);
    } catch (err) {
      runError = err;
    } finally {
      if (origGet === undefined) delete (Object.prototype as Record<string, unknown>)['get'];
      else Object.defineProperty(Object.prototype, 'get', origGet);
      if (origSet === undefined) delete (Object.prototype as Record<string, unknown>)['set'];
      else Object.defineProperty(Object.prototype, 'set', origSet);
    }

    assert.strictEqual(runError, undefined);
    assert.strictEqual(poisonCount, 0);
    assert.ok(typeof runResult === 'object' && runResult !== null);
    const res = runResult as { classification: { status: string }; raw: unknown; context: unknown };
    assert.strictEqual(res.classification.status, 'unknown');
    assert.strictEqual(res.raw, testErr);
    assert.strictEqual(res.context, testCtx);
  });
});
