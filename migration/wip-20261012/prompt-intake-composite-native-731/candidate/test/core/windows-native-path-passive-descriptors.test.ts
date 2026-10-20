import assert from 'node:assert/strict';
import {test} from 'node:test';
import {windowsNativePathToStringLossy} from '../../src/core/windows-native-path.ts';

test('native path normalized descriptors never inspect inherited get or set accessors', () => {
  const ordinary = {platform: 'windows-utf16', units: [0xd800, 65]};
  const nullPrototype = Object.assign(Object.create(null), {platform: 'windows-utf16', units: [0xd83d, 0xde00]});
  const originalGet = Object.getOwnPropertyDescriptor(Object.prototype, 'get');
  const originalSet = Object.getOwnPropertyDescriptor(Object.prototype, 'set');
  const restoreGet = originalGet === undefined ? undefined : Object.assign(Object.create(null), originalGet);
  const restoreSet = originalSet === undefined ? undefined : Object.assign(Object.create(null), originalSet);
  let hooks = 0, first: string | undefined, second: string | undefined, thrown: unknown;
  const getDescriptor = Object.assign(Object.create(null), {configurable: true, get() {hooks++; return undefined;}});
  const setDescriptor = Object.assign(Object.create(null), {configurable: true, get() {hooks++; return undefined;}});
  try {
    Object.defineProperty(Object.prototype, 'get', getDescriptor);
    Object.defineProperty(Object.prototype, 'set', setDescriptor);
    // No test framework or unrelated asynchronous operation in the poisoned interval.
    try {first = windowsNativePathToStringLossy(ordinary); second = windowsNativePathToStringLossy(nullPrototype);}
    catch (error) {thrown = error;}
  } finally {
    if (originalGet === undefined) Reflect.deleteProperty(Object.prototype, 'get');
    else Object.defineProperty(Object.prototype, 'get', restoreGet!);
    if (originalSet === undefined) Reflect.deleteProperty(Object.prototype, 'set');
    else Object.defineProperty(Object.prototype, 'set', restoreSet!);
  }
  assert.equal(thrown, undefined);
  assert.equal(first, '\uFFFDA');
  assert.equal(second, '😀');
  assert.equal(hooks, 0);
});
