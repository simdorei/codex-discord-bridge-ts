// SOURCE-ONLY qualification candidate. Copy unchanged into the same relative
// test/runtime/discord-runtime location beside the reviewed emitted src tree.
// No production owner is imported until every native submission guard is live.
let completed = 0;
let guardCalls = 0;
let passiveCalls = 0;
const EXPECTED_CASES = 40;
const sentinel = new Error('NATIVE_MIRROR_PREFLIGHT_FORBIDDEN_SUBMISSION');
const methods = ['run', 'runCpu', 'runControlCompletion', 'runObservationCompletion', 'runMaintenanceRead'];
const classes = ['Background', 'Control', 'Observation', 'Discovery', 'Maintenance'];
function requireCondition(value) {
  if (!value) throw new Error('NATIVE_MIRROR_PREFLIGHT_ASSERTION_FAILED');
}
try {
  const {OwnedWorkerSlot, ownedWorkerUsage} = await import('../../../src/runtime/owned-worker-slot.js');
  const prototype = OwnedWorkerSlot.prototype;
  // Validate the complete set before changing any descriptor. Never invoke or
  // retain an original method as a fallback, and never restore these guards.
  for (const name of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    requireCondition(descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'function' && descriptor.configurable === true);
  }
  const guard = function () { guardCalls++; throw sentinel; };
  for (const name of methods) {
    Object.defineProperty(prototype, name, {value: guard, writable: false, enumerable: false, configurable: false});
  }
  function untouched() {
    requireCondition(guardCalls === 0 && passiveCalls === 0);
    const usage = ownedWorkerUsage();
    requireCondition(Object.keys(usage).length === classes.length);
    for (const name of classes) requireCondition(usage[name] === 0);
    for (const name of methods) requireCondition(Object.getOwnPropertyDescriptor(prototype, name)?.value === guard);
  }
  untouched();
  const {refreshMirrorPolicyOffThread, createNativeMirrorPolicyRefresh} =
    await import('../../../src/runtime/discord-runtime/native-mirror-policy.js');
  const {InteractionAccessPolicy} = await import('../../../src/discord/interaction-access.js');
  untouched();
  const policy = new InteractionAccessPolicy();
  const path = '/native-mirror-preflight-never-open.sqlite';
  const limits = Object.freeze({maxRows: 1n, maxValueBytes: 1n, maxOutputIds: 1, timeoutMs: 1});
  const aborted = new AbortController();
  const abortReason = new Error('NATIVE_MIRROR_PREFLIGHT_ORIGINAL_ABORT');
  aborted.abort(abortReason);
  const typeText = error => error instanceof TypeError && error.message === 'Expected well-formed Discord text';
  const rangePath = error => error instanceof RangeError && error.message === 'Invalid native policy path';
  const rangeLimits = error => error instanceof RangeError && error.message === 'Invalid native policy limits';
  const ownField = error => error instanceof TypeError && error.message === 'Expected own gateway data field';
  const dataRecord = error => error instanceof TypeError && error.message === 'Expected gateway data record';
  const privatePolicy = error => error instanceof TypeError;
  async function rejectCase(name, operation, expected, synchronous = false) {
    requireCondition(typeof name === 'string');
    let caught = false;
    if (synchronous) {
      try { operation(); } catch (error) { caught = true; requireCondition(error !== sentinel && expected(error)); }
    } else {
      // A synchronous throw is not accepted for the async owner contract.
      const pending = operation();
      requireCondition(pending instanceof Promise);
      try { await pending; } catch (error) { caught = true; requireCondition(error !== sentinel && expected(error)); }
    }
    requireCondition(caught);
    untouched();
    completed++;
  }
  const refresh = (value, suppliedPath = path, suppliedLimits = limits, signal) =>
    refreshMirrorPolicyOffThread(value, suppliedPath, suppliedLimits, signal);
  // Cases 1-5: bounded invalid path inputs. Empty path is deliberately absent:
  // the production contract accepts it and resolves it against cwd.
  await rejectCase('path-nonstring', () => refresh(policy, 1), typeText);
  await rejectCase('path-surrogate', () => refresh(policy, '\ud800'), typeText);
  await rejectCase('path-nul', () => refresh(policy, 'a\0b'), rangePath);
  await rejectCase('path-code-unit-cap', () => refresh(policy, 'a'.repeat(32769)), rangePath);
  await rejectCase('path-utf8-cap', () => refresh(policy, 'é'.repeat(16385)), rangePath);
  // Cases 6-21: lower, upper, wrong primitive type and non-finite/fractional
  // failures for each independently bounded scalar.
  for (const [key, invalid] of [
    ['maxRows', [0n, 4097n, 1, null]],
    ['maxValueBytes', [0n, 4194305n, 1, null]],
    ['maxOutputIds', [0, 16385, 1n, 1.5]],
    ['timeoutMs', [0, 10001, 1n, NaN]],
  ]) {
    for (let index = 0; index < invalid.length; index++) {
      await rejectCase(`limits-${key}-${index}`, () => refresh(policy, path, {...limits, [key]: invalid[index]}), rangeLimits);
    }
  }
  // Cases 22-27: reject missing/accessor/inherited/proxy records without
  // invoking an accessor or any proxy trap.
  const accessor = {...limits};
  Object.defineProperty(accessor, 'maxRows', {get() { passiveCalls++; return 1n; }});
  const proxy = new Proxy(limits, {
    get() { passiveCalls++; throw new Error('UNEXPECTED_PROXY_GET'); },
    getOwnPropertyDescriptor() { passiveCalls++; throw new Error('UNEXPECTED_PROXY_DESCRIPTOR'); },
    getPrototypeOf() { passiveCalls++; throw new Error('UNEXPECTED_PROXY_PROTOTYPE'); },
    ownKeys() { passiveCalls++; throw new Error('UNEXPECTED_PROXY_KEYS'); },
  });
  await rejectCase('limits-missing', () => refresh(policy, path, {}), ownField);
  await rejectCase('limits-accessor', () => refresh(policy, path, accessor), ownField);
  await rejectCase('limits-inherited', () => refresh(policy, path, Object.create(limits)), ownField);
  await rejectCase('limits-proxy', () => refresh(policy, path, proxy), dataRecord);
  await rejectCase('limits-null', () => refresh(policy, path, null), dataRecord);
  await rejectCase('limits-function', () => refresh(policy, path, function () {}), dataRecord);
  // Cases 28-30: only the genuine private receiver is valid. These inputs must
  // fail at its private-field probe, never at native submission.
  await rejectCase('policy-lookalike', () => refresh({withMirroredChannelIds() { passiveCalls++; }}), privatePolicy);
  await rejectCase('policy-prototype-lookalike', () => refresh(Object.create(InteractionAccessPolicy.prototype)), privatePolicy);
  await rejectCase('policy-proxy', () => refresh(new Proxy(policy, {get() { passiveCalls++; }})), privatePolicy);
  // Cases 31-35 establish first-failure order and exact original abort reason.
  await rejectCase('abort-genuine', () => refresh(policy, path, limits, aborted.signal), error => error === abortReason);
  await rejectCase('abort-before-invalid-path', () => refresh({}, 1, {}, aborted.signal), error => error === abortReason);
  await rejectCase('path-before-limits-policy', () => refresh({}, '\0', {}), rangePath);
  await rejectCase('limits-before-private-policy', () => refresh({}, path, {...limits, timeoutMs: 0}), rangeLimits);
  await rejectCase('passive-limits-before-private-policy', () => refresh({}, path, accessor), ownField);
  // Cases 36-40 establish synchronous installation/path-identity checks.
  await rejectCase('factory-path-before-limits', () => createNativeMirrorPolicyRefresh('\0', {}), rangePath, true);
  await rejectCase('factory-invalid-limits', () => createNativeMirrorPolicyRefresh(path, {...limits, maxRows: 0n}), rangeLimits, true);
  const fixed = createNativeMirrorPolicyRefresh(path, limits);
  untouched();
  const mismatch = error => error instanceof TypeError && error.message === 'Mirror policy belongs to another database';
  await rejectCase('factory-original-path-mismatch', () => fixed(policy, path + '.other'), mismatch, true);
  await rejectCase('factory-mismatch-before-abort-policy', () => fixed({}, path + '.other', aborted.signal), mismatch, true);
  await rejectCase('factory-matching-path-abort', () => fixed(policy, path, aborted.signal), error => error === abortReason);
  requireCondition(completed === EXPECTED_CASES);
  untouched();
  process.stdout.write(JSON.stringify({kind: 'native-mirror-policy-preflight', cases: completed, expectedCases: EXPECTED_CASES, guardCalls, passiveCalls, nativeUsageZero: true, passed: true}) + '\n');
} catch {
  process.exitCode = 1;
  process.stdout.write(JSON.stringify({kind: 'native-mirror-policy-preflight', cases: completed, expectedCases: EXPECTED_CASES, guardCalls, passiveCalls, passed: false}) + '\n');
}
