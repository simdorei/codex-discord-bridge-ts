import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { classifyError } from '../../src/classifier/core.ts';
import type { ClassificationResult } from '../../src/classifier/schema.ts';
import { InvalidClassifierArgumentError } from '../../src/restart/thread-state.ts';

test('Object.prototype.allowedLiterals pollution does not invoke getter on validator without allowedLiterals', { concurrency: false }, () => {
  const rawError = new InvalidClassifierArgumentError(
    'expectedThreadId',
    'expectedThreadId must be a well-formed string',
  );
  const context = Object.freeze({ traceId: 'trace-test-1' });

  const origAllowedLiteralsDesc = Object.getOwnPropertyDescriptor(
    Object.prototype,
    'allowedLiterals',
  );
  const restoreAllowedLiteralsDesc = origAllowedLiteralsDesc
    ? Object.assign(Object.create(null), origAllowedLiteralsDesc)
    : null;

  let allowedLiteralsCount = 0;
  const installAllowedLiteralsDesc = Object.assign(Object.create(null), {
    get() {
      allowedLiteralsCount++;
      throw new Error('Poisoned Object.prototype.allowedLiterals getter invoked');
    },
    configurable: true,
    enumerable: false,
  });

  let result: ClassificationResult | undefined;
  let thrownError: unknown;

  try {
    Object.defineProperty(Object.prototype, 'allowedLiterals', installAllowedLiteralsDesc);
    try {
      result = classifyError(rawError, context);
    } catch (err) {
      thrownError = err;
    }
  } finally {
    if (restoreAllowedLiteralsDesc !== null) {
      Object.defineProperty(Object.prototype, 'allowedLiterals', restoreAllowedLiteralsDesc);
    } else {
      Reflect.deleteProperty(Object.prototype, 'allowedLiterals');
    }
  }

  assert.strictEqual(thrownError, undefined, 'classifyError must not throw during allowedLiterals pollution');
  assert.strictEqual(allowedLiteralsCount, 0, 'Object.prototype.allowedLiterals getter must not be invoked');
  assert.ok(result !== undefined, 'classification result must be returned');
  assert(result !== undefined);
  assert.strictEqual(result.raw, rawError, 'raw error identity reference must be preserved');
  assert.strictEqual(result.context, context, 'context reference must be preserved');
  assert.strictEqual(result.classification.status, 'classified');
  assert(result.classification.status === 'classified');
  assert.strictEqual(result.classification.matchKey, 'Restart.InvalidClassifierArgumentError');
  assert.strictEqual(Object.getPrototypeOf(result.classification.fields), null, 'fields must have null prototype');
  assert.strictEqual(Object.isFrozen(result.classification.fields), true, 'fields must be frozen');
  assert.deepStrictEqual(
    result.classification.fields,
    Object.assign(Object.create(null), { argument: 'expectedThreadId' }),
  );
});

test('Object.prototype.get and set pollution does not invoke getters during descriptor definition', { concurrency: false }, () => {
  const rawError = new InvalidClassifierArgumentError(
    'expectedThreadId',
    'expectedThreadId must be a well-formed string',
  );
  const context = Object.freeze({ traceId: 'trace-test-2' });

  const origGetDesc = Object.getOwnPropertyDescriptor(Object.prototype, 'get');
  const origSetDesc = Object.getOwnPropertyDescriptor(Object.prototype, 'set');
  const restoreGetDesc = origGetDesc ? Object.assign(Object.create(null), origGetDesc) : null;
  const restoreSetDesc = origSetDesc ? Object.assign(Object.create(null), origSetDesc) : null;

  let getCount = 0;
  const installGetDesc = Object.assign(Object.create(null), {
    get() {
      getCount++;
      throw new Error('Poisoned Object.prototype.get getter invoked');
    },
    configurable: true,
    enumerable: false,
  });

  let setCount = 0;
  const installSetDesc = Object.assign(Object.create(null), {
    get() {
      setCount++;
      throw new Error('Poisoned Object.prototype.set getter invoked');
    },
    configurable: true,
    enumerable: false,
  });

  let result: ClassificationResult | undefined;
  let thrownError: unknown;

  try {
    Object.defineProperty(Object.prototype, 'get', installGetDesc);
    Object.defineProperty(Object.prototype, 'set', installSetDesc);
    try {
      result = classifyError(rawError, context);
    } catch (err) {
      thrownError = err;
    }
  } finally {
    if (restoreGetDesc !== null) {
      Object.defineProperty(Object.prototype, 'get', restoreGetDesc);
    } else {
      Reflect.deleteProperty(Object.prototype, 'get');
    }
    if (restoreSetDesc !== null) {
      Object.defineProperty(Object.prototype, 'set', restoreSetDesc);
    } else {
      Reflect.deleteProperty(Object.prototype, 'set');
    }
  }

  assert.strictEqual(thrownError, undefined, 'classifyError must not throw during get/set pollution');
  assert.strictEqual(getCount, 0, 'Object.prototype.get getter must not be invoked');
  assert.strictEqual(setCount, 0, 'Object.prototype.set getter must not be invoked');
  assert.ok(result !== undefined, 'classification result must be returned');
  assert(result !== undefined);
  assert.strictEqual(result.raw, rawError, 'raw error identity reference must be preserved');
  assert.strictEqual(result.context, context, 'context reference must be preserved');
  assert.strictEqual(result.classification.status, 'classified');
  assert(result.classification.status === 'classified');
  assert.strictEqual(result.classification.matchKey, 'Restart.InvalidClassifierArgumentError');
  assert.strictEqual(Object.getPrototypeOf(result.classification.fields), null, 'fields must have null prototype');
  assert.strictEqual(Object.isFrozen(result.classification.fields), true, 'fields must be frozen');
  assert.deepStrictEqual(
    result.classification.fields,
    Object.assign(Object.create(null), { argument: 'expectedThreadId' }),
  );
});

test('cold registry import regression: Object.prototype.allowedLiterals pollution does not leak into registry initialization or freeze external arrays', { concurrency: false }, () => {
  const registryUrl = new URL('../../src/classifier/registry.ts', import.meta.url).href;

  const childCode = `
const externalArray = ['EXTERNAL_LEAK_TEST'];
let getterCalls = 0;

const origAllowedLiteralsDesc = Object.getOwnPropertyDescriptor(
  Object.prototype,
  'allowedLiterals',
);
const restoreAllowedLiteralsDesc = origAllowedLiteralsDesc
  ? Object.assign(Object.create(null), origAllowedLiteralsDesc)
  : null;

const poisonDesc = Object.assign(Object.create(null), {
  get() {
    getterCalls++;
    return externalArray;
  },
  configurable: true,
  enumerable: false,
});

let thrown = null;
let importSuccess = false;

try {
  Object.defineProperty(Object.prototype, 'allowedLiterals', poisonDesc);
  try {
    await import(process.argv[1]);
    importSuccess = true;
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  }
} finally {
  if (restoreAllowedLiteralsDesc !== null) {
    Object.defineProperty(Object.prototype, 'allowedLiterals', restoreAllowedLiteralsDesc);
  } else {
    Reflect.deleteProperty(Object.prototype, 'allowedLiterals');
  }
}

const payload = {
  getterCalls,
  thrown,
  importSuccess,
  externalArrayFrozen: Object.isFrozen(externalArray),
  externalArray,
};

process.stdout.write(JSON.stringify(payload));
`.trim();

  const childResult = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', childCode, registryUrl],
    {
      shell: false,
      timeout: 10000,
      env: { ...process.env },
      encoding: 'utf8',
    },
  );

  assert.strictEqual(childResult.error, undefined, 'child process must not encounter spawn error');
  assert.strictEqual(
    childResult.status,
    0,
    `child process must exit with code 0, stderr: ${childResult.stderr}`,
  );

  interface ChildReport {
    readonly getterCalls: number;
    readonly thrown: string | null;
    readonly importSuccess: boolean;
    readonly externalArrayFrozen: boolean;
    readonly externalArray: readonly string[];
  }

  const report = JSON.parse(childResult.stdout) as ChildReport;

  assert.strictEqual(report.thrown, null, 'cold registry import must not throw');
  assert.strictEqual(report.importSuccess, true, 'cold registry import must succeed');
  assert.strictEqual(
    report.getterCalls,
    0,
    'Object.prototype.allowedLiterals getter must not be invoked during cold registry import',
  );
  assert.strictEqual(
    report.externalArrayFrozen,
    false,
    'external array must remain unfrozen after cold registry import',
  );
  assert.deepStrictEqual(
    report.externalArray,
    ['EXTERNAL_LEAK_TEST'],
    'external array content must remain unchanged',
  );
});
