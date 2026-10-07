import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyThreadState,
  classifyThreadStateFromRawJson,
  InvalidClassifierArgumentError,
  InvalidThreadStateError,
  RestartReadinessError,
} from '../../src/restart/thread-state.ts';
import { U64_MAX } from '../../src/protocol/ids.ts';
import { rustDebugString } from '../../src/core/rust-debug.ts';

function assertInvalidClassifierArgument(
  action: () => unknown,
  expectedArgument: string,
  expectedMessage: string,
): void {
  assert.throws(
    action,
    (err: unknown) => {
      assert(err instanceof Error, 'expected err to be an instance of Error');
      assert(
        err instanceof TypeError,
        'expected err to be an instance of TypeError',
      );
      assert(
        err instanceof InvalidClassifierArgumentError,
        'expected err to be an instance of InvalidClassifierArgumentError',
      );
      assert.strictEqual(
        (err as InvalidClassifierArgumentError).name,
        'InvalidClassifierArgumentError',
      );
      assert.strictEqual(
        (err as InvalidClassifierArgumentError).argument,
        expectedArgument,
      );
      assert.strictEqual(
        (err as InvalidClassifierArgumentError).message,
        expectedMessage,
      );
      assert.strictEqual(
        Object.getPrototypeOf(err),
        InvalidClassifierArgumentError.prototype,
      );
      return true;
    },
  );
}

function assertInvalidThreadState(
  action: () => unknown,
  expectedThreadId: string,
  expectedReason: string,
): void {
  assert.throws(
    action,
    (err: unknown) => {
      assert(err instanceof Error, 'expected err to be an instance of Error');
      assert(
        err instanceof InvalidThreadStateError,
        'expected err to be an instance of InvalidThreadStateError',
      );
      assert.strictEqual(
        (err as InvalidThreadStateError).name,
        'InvalidThreadStateError',
      );
      assert.strictEqual(
        (err as InvalidThreadStateError).threadId,
        expectedThreadId,
      );
      assert.strictEqual(
        (err as InvalidThreadStateError).thread_id,
        expectedThreadId,
      );
      assert.strictEqual(
        (err as InvalidThreadStateError).reason,
        expectedReason,
      );
      assert.strictEqual(
        (err as InvalidThreadStateError).message,
        `invalid app-server thread state for ${expectedThreadId}: ${expectedReason}`,
      );
      assert.strictEqual(
        Object.getPrototypeOf(err),
        InvalidThreadStateError.prototype,
      );
      return true;
    },
  );
}

describe('Thread State Classifier - Error Identity and Aliases', () => {
  it('exposes RestartReadinessError.InvalidThreadState identity and property contract', () => {
    assert.strictEqual(
      RestartReadinessError.InvalidThreadState,
      InvalidThreadStateError,
    );

    const err = new InvalidThreadStateError('thread-xyz', 'test reason');
    assert(err instanceof Error);
    assert(err instanceof InvalidThreadStateError);
    assert(err instanceof RestartReadinessError.InvalidThreadState);
    assert.strictEqual(err.name, 'InvalidThreadStateError');
    assert.strictEqual(err.threadId, 'thread-xyz');
    assert.strictEqual(err.thread_id, 'thread-xyz');
    assert.strictEqual(err.reason, 'test reason');
    assert.strictEqual(
      err.message,
      'invalid app-server thread state for thread-xyz: test reason',
    );
    assert.strictEqual(
      Object.getPrototypeOf(err),
      InvalidThreadStateError.prototype,
    );
  });

  it('exposes RestartReadinessError.InvalidClassifierArgument identity and property contract', () => {
    assert.strictEqual(
      RestartReadinessError.InvalidClassifierArgument,
      InvalidClassifierArgumentError,
    );

    const err = new InvalidClassifierArgumentError(
      'expectedThreadId',
      'expectedThreadId must be a well-formed string',
    );
    assert(err instanceof Error);
    assert(err instanceof TypeError);
    assert(err instanceof InvalidClassifierArgumentError);
    assert(err instanceof RestartReadinessError.InvalidClassifierArgument);
    assert.strictEqual(err.name, 'InvalidClassifierArgumentError');
    assert.strictEqual(err.argument, 'expectedThreadId');
    assert.strictEqual(
      err.message,
      'expectedThreadId must be a well-formed string',
    );
    assert.strictEqual(
      Object.getPrototypeOf(err),
      InvalidClassifierArgumentError.prototype,
    );
  });
});
describe('Thread State Classifier - Exact Error Ordering', () => {
  const tid = 'th-order-1';
  const now = 100n;
  const quiet = 10n;

  it('step 1: missing thread object precedes thread id, updatedAt, and status', () => {
    const invalidRoots = [
      null,
      undefined,
      123,
      'string',
      true,
      [],
      {},
      { other: 'value' },
      { thread: null },
      { thread: [] },
      { thread: 'th-order-1' },
      { thread: 123 },
      { thread: true },
    ];

    for (const root of invalidRoots) {
      assertInvalidThreadState(
        () => classifyThreadState(root, tid, quiet, now),
        tid,
        'missing thread object',
      );
    }
  });

  it('step 2: missing thread id precedes thread id mismatch, updatedAt, and status', () => {
    const invalidIds = [
      {},
      { id: null },
      { id: 123 },
      { id: true },
      { id: [] },
      { id: {} },
    ];

    for (const thread of invalidIds) {
      assertInvalidThreadState(
        () => classifyThreadState({ thread }, tid, quiet, now),
        tid,
        'missing thread id',
      );
    }
  });

  it('step 3: thread id mismatch precedes updatedAt and status validation', () => {
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: 'th-other',
              updatedAt: 'not-a-bigint',
              status: null,
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'thread id mismatch',
    );
  });

  it('step 4: missing or invalid updatedAt precedes status object and status type', () => {
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              status: null,
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing or invalid updatedAt',
    );

    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 1,
              status: 'not-an-object',
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing or invalid updatedAt',
    );
  });

  it('step 5: missing status object precedes status type validation', () => {
    const invalidStatuses = [
      undefined,
      null,
      [],
      'idle',
      123,
      true,
    ];

    for (const status of invalidStatuses) {
      assertInvalidThreadState(
        () =>
          classifyThreadState(
            {
              thread: {
                id: tid,
                updatedAt: 50n,
                ...(status !== undefined ? { status } : {}),
              },
            },
            tid,
            quiet,
            now,
          ),
        tid,
        'missing status object',
      );
    }
  });

  it('step 6: missing status type precedes status-specific evaluation', () => {
    const invalidTypes = [
      undefined,
      null,
      123,
      true,
      [],
      {},
    ];

    for (const type of invalidTypes) {
      assertInvalidThreadState(
        () =>
          classifyThreadState(
            {
              thread: {
                id: tid,
                updatedAt: 50n,
                status: type !== undefined ? { type } : {},
              },
            },
            tid,
            quiet,
            now,
          ),
        tid,
        'missing status type',
      );
    }
  });
});

describe('Thread State Classifier - updatedAt Provenance and u64 Range', () => {
  const tid = 'th-u64-1';
  const now = 100n;
  const quiet = 10n;

  it('accepts exact bigint u64 boundaries 0n and U64_MAX', () => {
    const readyAtZero = classifyThreadState(
      {
        thread: {
          id: tid,
          updatedAt: 0n,
          status: { type: 'idle' },
        },
      },
      tid,
      quiet,
      now,
    );
    assert.deepStrictEqual(readyAtZero, { status: 'Ready' });

    const readyAtMax = classifyThreadState(
      {
        thread: {
          id: tid,
          updatedAt: U64_MAX,
          status: { type: 'idle' },
        },
      },
      tid,
      0n,
      U64_MAX,
    );
    assert.deepStrictEqual(readyAtMax, { status: 'Ready' });
  });

  it('strictly rejects negative bigints and u64 overflow bigints', () => {
    const invalidBigints = [
      -1n,
      -100n,
      -9223372036854775808n,
      U64_MAX + 1n,
      U64_MAX + 100n,
    ];

    for (const updatedAt of invalidBigints) {
      assertInvalidThreadState(
        () =>
          classifyThreadState(
            {
              thread: {
                id: tid,
                updatedAt,
                status: { type: 'idle' },
              },
            },
            tid,
            quiet,
            now,
          ),
        tid,
        'missing or invalid updatedAt',
      );
    }
  });

  it('strictly rejects all JS numbers including 1, 0, -0, 1.0, 1e0, floats, NaNs, and infinities', () => {
    const numberValues = [
      1,
      0,
      -0,
      1.0,
      1e0,
      1.5,
      -1,
      Number.MAX_SAFE_INTEGER,
      NaN,
      Infinity,
      -Infinity,
    ];

    for (const val of numberValues) {
      assertInvalidThreadState(
        () =>
          classifyThreadState(
            {
              thread: {
                id: tid,
                updatedAt: val,
                status: { type: 'idle' },
              },
            },
            tid,
            quiet,
            now,
          ),
        tid,
        'missing or invalid updatedAt',
      );
    }
  });

  it('strictly rejects non-bigint types (strings, booleans, objects, null)', () => {
    const nonBigints = [
      '100',
      '0',
      true,
      false,
      null,
      {},
      [],
    ];

    for (const val of nonBigints) {
      assertInvalidThreadState(
        () =>
          classifyThreadState(
            {
              thread: {
                id: tid,
                updatedAt: val,
                status: { type: 'idle' },
              },
            },
            tid,
            quiet,
            now,
          ),
        tid,
        'missing or invalid updatedAt',
      );
    }
  });
});

describe('Thread State Classifier - updatedAt Prior to Status Evaluation Across ALL Statuses', () => {
  const tid = 'th-allstat-1';
  const now = 100n;
  const quiet = 10n;

  const statusesToTest = [
    { name: 'active with flags', status: { type: 'active', activeFlags: ['waitingOnApproval'] } },
    { name: 'active without flags', status: { type: 'active' } },
    { name: 'systemError', status: { type: 'systemError' } },
    { name: 'idle', status: { type: 'idle' } },
    { name: 'notLoaded', status: { type: 'notLoaded' } },
    { name: 'unknown status', status: { type: 'unknownStatusType' } },
  ];

  it('rejects number 1, -0, negative bigint, and overflow bigint BEFORE inspecting status for ALL statuses', () => {
    for (const { status } of statusesToTest) {
      const invalidUpdates = [
        1,
        -0,
        -1n,
        U64_MAX + 1n,
      ];

      for (const updatedAt of invalidUpdates) {
        assertInvalidThreadState(
          () =>
            classifyThreadState(
              {
                thread: {
                  id: tid,
                  updatedAt,
                  status,
                },
              },
              tid,
              quiet,
              now,
            ),
          tid,
          'missing or invalid updatedAt',
        );
      }
    }
  });

  it('contrasts raw integer 1 vs 1.0, 1e0, and -0 in classifyThreadStateFromRawJson across ALL statuses', () => {
    const standardStatuses: Array<{
      type: string;
      flagsJson?: string;
      expectedBlockedReason?: string;
    }> = [
      {
        type: 'active',
        flagsJson: ',"activeFlags":[]',
        expectedBlockedReason: `thread ${tid} is active`,
      },
      {
        type: 'systemError',
        expectedBlockedReason: `thread ${tid} has systemError status`,
      },
      {
        type: 'idle',
      },
      {
        type: 'notLoaded',
      },
    ];

    for (const target of standardStatuses) {
      const flagsPart = target.flagsJson ?? '';

      const rawIntegerJson = `{"thread":{"id":"${tid}","updatedAt":1,"status":{"type":"${target.type}"${flagsPart}}}}`;
      const resultInteger = classifyThreadStateFromRawJson(
        rawIntegerJson,
        tid,
        quiet,
        now,
      );

      if (target.expectedBlockedReason !== undefined) {
        assert.deepStrictEqual(resultInteger, {
          status: 'Blocked',
          reason: target.expectedBlockedReason,
        });
      } else {
        assert.deepStrictEqual(resultInteger, { status: 'Ready' });
      }

      const rawFloatJson = `{"thread":{"id":"${tid}","updatedAt":1.0,"status":{"type":"${target.type}"${flagsPart}}}}`;
      assertInvalidThreadState(
        () => classifyThreadStateFromRawJson(rawFloatJson, tid, quiet, now),
        tid,
        'missing or invalid updatedAt',
      );

      const rawExponentJson = `{"thread":{"id":"${tid}","updatedAt":1e0,"status":{"type":"${target.type}"${flagsPart}}}}`;
      assertInvalidThreadState(
        () => classifyThreadStateFromRawJson(rawExponentJson, tid, quiet, now),
        tid,
        'missing or invalid updatedAt',
      );

      const rawNegativeZeroJson = `{"thread":{"id":"${tid}","updatedAt":-0,"status":{"type":"${target.type}"${flagsPart}}}}`;
      assertInvalidThreadState(
        () => classifyThreadStateFromRawJson(rawNegativeZeroJson, tid, quiet, now),
        tid,
        'missing or invalid updatedAt',
      );

      const rawNegativeIntJson = `{"thread":{"id":"${tid}","updatedAt":-1,"status":{"type":"${target.type}"${flagsPart}}}}`;
      assertInvalidThreadState(
        () => classifyThreadStateFromRawJson(rawNegativeIntJson, tid, quiet, now),
        tid,
        'missing or invalid updatedAt',
      );

      const rawZeroJson = `{"thread":{"id":"${tid}","updatedAt":0,"status":{"type":"${target.type}"${flagsPart}}}}`;
      const resultZero = classifyThreadStateFromRawJson(
        rawZeroJson,
        tid,
        quiet,
        now,
      );
      if (target.expectedBlockedReason !== undefined) {
        assert.deepStrictEqual(resultZero, {
          status: 'Blocked',
          reason: target.expectedBlockedReason,
        });
      } else {
        assert.deepStrictEqual(resultZero, { status: 'Ready' });
      }

      const rawU64MaxJson = `{"thread":{"id":"${tid}","updatedAt":18446744073709551615,"status":{"type":"${target.type}"${flagsPart}}}}`;
      const resultU64Max = classifyThreadStateFromRawJson(
        rawU64MaxJson,
        tid,
        0n,
        U64_MAX,
      );
      if (target.expectedBlockedReason !== undefined) {
        assert.deepStrictEqual(resultU64Max, {
          status: 'Blocked',
          reason: target.expectedBlockedReason,
        });
      } else {
        assert.deepStrictEqual(resultU64Max, { status: 'Ready' });
      }
    }
  });
});

describe('Thread State Classifier - Active Status Validation and Ordering', () => {
  const tid = 'th-active-1';
  const now = 100n;
  const quiet = 10n;
  const updatedAt = 50n;

  it('requires activeFlags to be an array', () => {
    const nonArrays = [
      undefined,
      null,
      'waitingOnApproval',
      123,
      true,
      {},
    ];

    for (const activeFlags of nonArrays) {
      assertInvalidThreadState(
        () =>
          classifyThreadState(
            {
              thread: {
                id: tid,
                updatedAt,
                status: {
                  type: 'active',
                  ...(activeFlags !== undefined ? { activeFlags } : {}),
                },
              },
            },
            tid,
            quiet,
            now,
          ),
        tid,
        'active status has no activeFlags array',
      );
    }
  });

  it('formats empty activeFlags without trailing flags suffix', () => {
    const res = classifyThreadState(
      {
        thread: {
          id: tid,
          updatedAt,
          status: {
            type: 'active',
            activeFlags: [],
          },
        },
      },
      tid,
      quiet,
      now,
    );

    assert.deepStrictEqual(res, {
      status: 'Blocked',
      reason: `thread ${tid} is active`,
    });
  });

  it('formats valid activeFlags preserving duplicates and iteration order', () => {
    const cases: Array<{
      flags: string[];
      expectedReason: string;
    }> = [
      {
        flags: ['waitingOnApproval'],
        expectedReason: `thread ${tid} is active flags=waitingOnApproval`,
      },
      {
        flags: ['waitingOnUserInput'],
        expectedReason: `thread ${tid} is active flags=waitingOnUserInput`,
      },
      {
        flags: ['waitingOnApproval', 'waitingOnUserInput'],
        expectedReason: `thread ${tid} is active flags=waitingOnApproval,waitingOnUserInput`,
      },
      {
        flags: ['waitingOnUserInput', 'waitingOnApproval'],
        expectedReason: `thread ${tid} is active flags=waitingOnUserInput,waitingOnApproval`,
      },
      {
        flags: ['waitingOnApproval', 'waitingOnApproval'],
        expectedReason: `thread ${tid} is active flags=waitingOnApproval,waitingOnApproval`,
      },
      {
        flags: ['waitingOnUserInput', 'waitingOnUserInput', 'waitingOnApproval'],
        expectedReason: `thread ${tid} is active flags=waitingOnUserInput,waitingOnUserInput,waitingOnApproval`,
      },
    ];

    for (const c of cases) {
      const res = classifyThreadState(
        {
          thread: {
            id: tid,
            updatedAt,
            status: {
              type: 'active',
              activeFlags: c.flags,
            },
          },
        },
        tid,
        quiet,
        now,
      );
      assert.deepStrictEqual(res, {
        status: 'Blocked',
        reason: c.expectedReason,
      });
    }
  });

  it('interleaves validation per element in source order: text first, then membership', () => {
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt,
              status: {
                type: 'active',
                activeFlags: ['unknownFlag', 1],
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      `unknown active flag ${rustDebugString('unknownFlag')}`,
    );

    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt,
              status: {
                type: 'active',
                activeFlags: [1, 'unknownFlag'],
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'active flag is not text',
    );

    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt,
              status: {
                type: 'active',
                activeFlags: ['waitingOnApproval', null],
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'active flag is not text',
    );

    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt,
              status: {
                type: 'active',
                activeFlags: ['waitingOnApproval', 'waitingOnOAuth'],
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      `unknown active flag ${rustDebugString('waitingOnOAuth')}`,
    );

    const nonTexts = [
      null,
      undefined,
      123,
      10n,
      true,
      false,
      {},
      [],
    ];

    for (const item of nonTexts) {
      assertInvalidThreadState(
        () =>
          classifyThreadState(
            {
              thread: {
                id: tid,
                updatedAt,
                status: {
                  type: 'active',
                  activeFlags: [item],
                },
              },
            },
            tid,
            quiet,
            now,
          ),
        tid,
        'active flag is not text',
      );
    }
  });

  it('formats unknown active flag with RustDebug string formatting', () => {
    const testCases = [
      'unknownFlag',
      'waiting_on_tool',
      'waiting\0null',
      'waiting\t\nflag',
      'flag"quoted"',
      'flag\\backslash',
      '\x1b[31m',
      '한글플래그',
    ];

    for (const flag of testCases) {
      assertInvalidThreadState(
        () =>
          classifyThreadState(
            {
              thread: {
                id: tid,
                updatedAt,
                status: {
                  type: 'active',
                  activeFlags: [flag],
                },
              },
            },
            tid,
            quiet,
            now,
          ),
        tid,
        `unknown active flag ${rustDebugString(flag)}`,
      );
    }
  });
});

describe('Thread State Classifier - SystemError Status', () => {
  const tid = 'th-sys-1';

  it('returns Blocked with systemError reason regardless of quiet and now', () => {
    const res = classifyThreadState(
      {
        thread: {
          id: tid,
          updatedAt: 50n,
          status: { type: 'systemError' },
        },
      },
      tid,
      10n,
      100n,
    );

    assert.deepStrictEqual(res, {
      status: 'Blocked',
      reason: `thread ${tid} has systemError status`,
    });
  });

  it('returns systemError even when updatedAt is in the future relative to nowSeconds', () => {
    const res = classifyThreadState(
      {
        thread: {
          id: tid,
          updatedAt: 500n,
          status: { type: 'systemError' },
        },
      },
      tid,
      10n,
      100n,
    );

    assert.deepStrictEqual(res, {
      status: 'Blocked',
      reason: `thread ${tid} has systemError status`,
    });
  });

  it('still enforces valid u64 updatedAt before returning systemError', () => {
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 1,
              status: { type: 'systemError' },
            },
          },
          tid,
          10n,
          100n,
        ),
      tid,
      'missing or invalid updatedAt',
    );
  });
});
describe('Thread State Classifier - Idle and NotLoaded Status Boundaries', () => {
  const tid = 'th-idle-1';
  const candidateStatuses = ['idle', 'notLoaded'] as const;

  for (const statusType of candidateStatuses) {
    describe(`Status "${statusType}"`, () => {
      it('blocks when updatedAt is in the future (updatedAt > nowSeconds)', () => {
        const res = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 105n,
              status: { type: statusType },
            },
          },
          tid,
          10n,
          100n,
        );

        assert.deepStrictEqual(res, {
          status: 'Blocked',
          reason: `thread ${tid} is recent: updated_at=105 quiet_seconds=10`,
        });
      });

      it('blocks when inside quiet window (nowSeconds - updatedAt < quietSeconds)', () => {
        const res1 = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 95n,
              status: { type: statusType },
            },
          },
          tid,
          10n,
          100n,
        );
        assert.deepStrictEqual(res1, {
          status: 'Blocked',
          reason: `thread ${tid} is recent: updated_at=95 quiet_seconds=10`,
        });

        const res2 = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 91n,
              status: { type: statusType },
            },
          },
          tid,
          10n,
          100n,
        );
        assert.deepStrictEqual(res2, {
          status: 'Blocked',
          reason: `thread ${tid} is recent: updated_at=91 quiet_seconds=10`,
        });
      });

      it('returns Ready at exact quiet boundary (nowSeconds - updatedAt === quietSeconds)', () => {
        const res = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 90n,
              status: { type: statusType },
            },
          },
          tid,
          10n,
          100n,
        );
        assert.deepStrictEqual(res, { status: 'Ready' });
      });

      it('returns Ready when past quiet boundary (nowSeconds - updatedAt > quietSeconds)', () => {
        const res1 = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 89n,
              status: { type: statusType },
            },
          },
          tid,
          10n,
          100n,
        );
        assert.deepStrictEqual(res1, { status: 'Ready' });

        const res2 = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 0n,
              status: { type: statusType },
            },
          },
          tid,
          10n,
          100n,
        );
        assert.deepStrictEqual(res2, { status: 'Ready' });
      });

      it('evaluates correctly when quietSeconds is 0n', () => {
        const res1 = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 100n,
              status: { type: statusType },
            },
          },
          tid,
          0n,
          100n,
        );
        assert.deepStrictEqual(res1, { status: 'Ready' });

        const res2 = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: { type: statusType },
            },
          },
          tid,
          0n,
          100n,
        );
        assert.deepStrictEqual(res2, { status: 'Ready' });

        const res3 = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 101n,
              status: { type: statusType },
            },
          },
          tid,
          0n,
          100n,
        );
        assert.deepStrictEqual(res3, {
          status: 'Blocked',
          reason: `thread ${tid} is recent: updated_at=101 quiet_seconds=0`,
        });
      });

      it('evaluates boundary when quietSeconds or nowSeconds is U64_MAX', () => {
        const res1 = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 0n,
              status: { type: statusType },
            },
          },
          tid,
          U64_MAX,
          U64_MAX,
        );
        assert.deepStrictEqual(res1, { status: 'Ready' });

        const res2 = classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 0n,
              status: { type: statusType },
            },
          },
          tid,
          U64_MAX,
          U64_MAX - 1n,
        );
        assert.deepStrictEqual(res2, {
          status: 'Blocked',
          reason: `thread ${tid} is recent: updated_at=0 quiet_seconds=${U64_MAX}`,
        });
      });
    });
  }
});

describe('Thread State Classifier - Unknown Status Types and RustDebug Formatting', () => {
  const tid = 'th-unk-1';
  const now = 100n;
  const quiet = 10n;
  const updatedAt = 50n;

  it('rejects unknown status types with exact rustDebugString formatted message', () => {
    const unknownTypes = [
      'pending',
      'stopped',
      'Active',
      'Idle',
      'NotLoaded',
      'SystemError',
      'status\0null',
      'status\t\r\nwhitespace',
      'status"quoted"',
      'status\\backslash',
      '\x1b[32mGreen',
      '\x01Control',
      '대기상태',
      'état',
    ];

    for (const statusType of unknownTypes) {
      assertInvalidThreadState(
        () =>
          classifyThreadState(
            {
              thread: {
                id: tid,
                updatedAt,
                status: { type: statusType },
              },
            },
            tid,
            quiet,
            now,
          ),
        tid,
        `unknown status type ${rustDebugString(statusType)}`,
      );
    }
  });
});

describe('Thread State Classifier - Raw Wrapper and Native Parser Errors', () => {
  const tid = 'th-raw-1';
  const now = 100n;
  const quiet = 10n;

  it('retains native TypeError when rawJson input is not a string', () => {
    const nonStrings = [
      null,
      undefined,
      123,
      true,
      {},
      [],
    ];

    for (const input of nonStrings) {
      assert.throws(
        () =>
          classifyThreadStateFromRawJson(
            input as unknown as string,
            tid,
            quiet,
            now,
          ),
        (err: unknown) => {
          assert(err instanceof TypeError);
          assert.strictEqual((err as TypeError).message, 'Expected string input');
          assert(!(err instanceof InvalidThreadStateError));
          return true;
        },
      );
    }
  });

  it('retains native SyntaxError on malformed JSON grammar without wrapping in InvalidThreadStateError', () => {
    const malformedSnippets = [
      '',
      '{',
      '{"thread":',
      '{ thread: 1 }',
      '{"thread": {"id": "th-raw-1", "updatedAt": }}',
      '{"thread": {"id": "th-raw-1", "updatedAt": 01}}',
    ];

    for (const raw of malformedSnippets) {
      assert.throws(
        () => classifyThreadStateFromRawJson(raw, tid, quiet, now),
        (err: unknown) => {
          assert(err instanceof SyntaxError);
          assert(!(err instanceof InvalidThreadStateError));
          return true;
        },
      );
    }
  });

  it('retains native SyntaxError on lone UTF-16 surrogates in string tokens', () => {
    const surrogateSnippets = [
      '{"thread":{"id":"th-raw-1","updatedAt":10,"status":{"type":"idle"}},"extra":"\\uD800"}',
      '{"thread":{"id":"th-raw-1","updatedAt":10,"status":{"type":"idle"}},"extra":"\\uDC00"}',
      '{"thread":{"id":"th-raw-1\\uD83D","updatedAt":10,"status":{"type":"idle"}}}',
    ];

    for (const raw of surrogateSnippets) {
      assert.throws(
        () => classifyThreadStateFromRawJson(raw, tid, quiet, now),
        (err: unknown) => {
          assert(err instanceof SyntaxError);
          assert.strictEqual(
            (err as SyntaxError).message,
            'Lone UTF-16 surrogate in string token',
          );
          assert(!(err instanceof InvalidThreadStateError));
          return true;
        },
      );
    }
  });

  it('retains native SyntaxError on nesting depth >= 128', () => {
    const deepExceeded = '['.repeat(128) + ']'.repeat(128);
    assert.throws(
      () => classifyThreadStateFromRawJson(deepExceeded, tid, quiet, now),
      (err: unknown) => {
        assert(err instanceof SyntaxError);
        assert.strictEqual(
          (err as SyntaxError).message,
          'Recursion limit exceeded: depth >= 128',
        );
        assert(!(err instanceof InvalidThreadStateError));
        return true;
      },
    );

    const depth127 = '['.repeat(127) + ']'.repeat(127);
    assertInvalidThreadState(
      () => classifyThreadStateFromRawJson(depth127, tid, quiet, now),
      tid,
      'missing thread object',
    );
  });

  it('properly classifies valid raw JSON for all statuses', () => {
    const activeRaw = JSON.stringify({
      thread: {
        id: tid,
        updatedAt: 50,
        status: {
          type: 'active',
          activeFlags: ['waitingOnApproval', 'waitingOnUserInput'],
        },
      },
    });
    const activeRes = classifyThreadStateFromRawJson(activeRaw, tid, quiet, now);
    assert.deepStrictEqual(activeRes, {
      status: 'Blocked',
      reason: `thread ${tid} is active flags=waitingOnApproval,waitingOnUserInput`,
    });

    const systemErrorRaw = JSON.stringify({
      thread: {
        id: tid,
        updatedAt: 50,
        status: { type: 'systemError' },
      },
    });
    const sysRes = classifyThreadStateFromRawJson(systemErrorRaw, tid, quiet, now);
    assert.deepStrictEqual(sysRes, {
      status: 'Blocked',
      reason: `thread ${tid} has systemError status`,
    });

    const idleRaw = JSON.stringify({
      thread: {
        id: tid,
        updatedAt: 50,
        status: { type: 'idle' },
      },
    });
    const idleRes = classifyThreadStateFromRawJson(idleRaw, tid, quiet, now);
    assert.deepStrictEqual(idleRes, { status: 'Ready' });

    const notLoadedRaw = JSON.stringify({
      thread: {
        id: tid,
        updatedAt: 50,
        status: { type: 'notLoaded' },
      },
    });
    const notLoadedRes = classifyThreadStateFromRawJson(notLoadedRaw, tid, quiet, now);
    assert.deepStrictEqual(notLoadedRes, { status: 'Ready' });
  });
});

describe('Thread State Classifier - Argument Validation and Precedence', () => {
  const tid = 'th-args-1';
  const now = 100n;
  const quiet = 10n;
  const validPayload = {
    thread: {
      id: tid,
      updatedAt: 50n,
      status: { type: 'idle' },
    },
  };

  it('strictly validates expectedThreadId primitive string without coercion', () => {
    const invalidThreadIds = [
      null,
      undefined,
      123,
      true,
      false,
      10n,
      {},
      [],
      new String(tid),
    ];

    for (const val of invalidThreadIds) {
      assertInvalidClassifierArgument(
        () => classifyThreadState(validPayload, val as unknown as string, quiet, now),
        'expectedThreadId',
        'expectedThreadId must be a well-formed string',
      );
    }
  });

  it('ensures zero hooks or traps are called on boxed or proxy expectedThreadId', () => {
    let hookCalled = false;
    const proxyId = new Proxy(new String(tid), {
      get(target, prop, receiver) {
        hookCalled = true;
        return Reflect.get(target, prop, receiver);
      },
    });

    assertInvalidClassifierArgument(
      () => classifyThreadState(validPayload, proxyId as unknown as string, quiet, now),
      'expectedThreadId',
      'expectedThreadId must be a well-formed string',
    );
    assert.strictEqual(hookCalled, false, 'zero hooks should be invoked on expectedThreadId proxy');

    const coercionTrap = {
      toString() {
        hookCalled = true;
        return tid;
      },
      valueOf() {
        hookCalled = true;
        return tid;
      },
    };

    assertInvalidClassifierArgument(
      () => classifyThreadState(validPayload, coercionTrap as unknown as string, quiet, now),
      'expectedThreadId',
      'expectedThreadId must be a well-formed string',
    );
    assert.strictEqual(hookCalled, false, 'coercion methods must not be called');
  });

  it('rejects lone UTF-16 surrogates in expectedThreadId', () => {
    const surrogateIds = [
      '\uD800',
      '\uDFFF',
      '\uDC00',
      'th-\uD800',
      'th-\uDC00-end',
      '\uD800\uD800',
      '\uD83D',
      'prefix\uDE00suffix',
    ];

    for (const id of surrogateIds) {
      assertInvalidClassifierArgument(
        () => classifyThreadState(validPayload, id, quiet, now),
        'expectedThreadId',
        'expectedThreadId must be a well-formed string',
      );
    }
  });

  it('rejects lone UTF-16 surrogates even when String.prototype.isWellFormed is overridden', () => {
    const originalDesc = Object.getOwnPropertyDescriptor(
      String.prototype,
      'isWellFormed',
    );
    let counter = 0;
    try {
      Object.defineProperty(String.prototype, 'isWellFormed', {
        value: () => {
          counter++;
          return true;
        },
        configurable: true,
        writable: true,
      });

      assertInvalidClassifierArgument(
        () => classifyThreadState(validPayload, '\uD800', quiet, now),
        'expectedThreadId',
        'expectedThreadId must be a well-formed string',
      );
      assert.strictEqual(counter, 0);

      const res = classifyThreadState(validPayload, tid, quiet, now);
      assert.deepStrictEqual(res, { status: 'Ready' });
      assert.strictEqual(counter, 0);
    } finally {
      if (originalDesc) {
        Object.defineProperty(String.prototype, 'isWellFormed', originalDesc);
      } else {
        Reflect.deleteProperty(String.prototype, 'isWellFormed');
      }
    }
  });

  it('accepts well-formed UTF-16 strings for expectedThreadId', () => {
    const validIds = [
      tid,
      'thread_simple',
      'thread_\uD83D\uDE00',
      '한글_스레드',
    ];

    for (const id of validIds) {
      const payload = {
        thread: {
          id,
          updatedAt: 50n,
          status: { type: 'idle' },
        },
      };
      const res = classifyThreadState(payload, id, quiet, now);
      assert.deepStrictEqual(res, { status: 'Ready' });
    }
  });

  it('strictly validates quietSeconds boundaries, rejects negative bigints, over U64_MAX, and ALL numbers', () => {
    const invalidQuietValues = [
      -1n,
      -100n,
      -9223372036854775808n,
      U64_MAX + 1n,
      U64_MAX + 100n,
      1,
      0,
      -0,
      1.0,
      1e0,
      1.5,
      -1,
      Number.MAX_SAFE_INTEGER,
      NaN,
      Infinity,
      -Infinity,
      null,
      undefined,
      '10',
      true,
      {},
      [],
    ];

    for (const val of invalidQuietValues) {
      assertInvalidClassifierArgument(
        () => classifyThreadState(validPayload, tid, val as unknown as bigint, now),
        'quietSeconds',
        'quietSeconds must be a bigint between 0 and U64_MAX',
      );
    }
  });

  it('ensures invalid quietSeconds cannot authorize Ready', () => {
    const readyCandidatePayload = {
      thread: {
        id: tid,
        updatedAt: 0n,
        status: { type: 'idle' },
      },
    };

    assertInvalidClassifierArgument(
      () => classifyThreadState(readyCandidatePayload, tid, -1n, 100n),
      'quietSeconds',
      'quietSeconds must be a bigint between 0 and U64_MAX',
    );

    assertInvalidClassifierArgument(
      () => classifyThreadState(readyCandidatePayload, tid, 1 as unknown as bigint, 100n),
      'quietSeconds',
      'quietSeconds must be a bigint between 0 and U64_MAX',
    );
  });

  it('strictly validates nowSeconds boundaries, rejects negative bigints, over U64_MAX, and ALL numbers', () => {
    const invalidNowValues = [
      -1n,
      -100n,
      -9223372036854775808n,
      U64_MAX + 1n,
      U64_MAX + 100n,
      1,
      0,
      -0,
      1.0,
      1e0,
      1.5,
      -1,
      Number.MAX_SAFE_INTEGER,
      NaN,
      Infinity,
      -Infinity,
      null,
      undefined,
      '100',
      true,
      {},
      [],
    ];

    for (const val of invalidNowValues) {
      assertInvalidClassifierArgument(
        () => classifyThreadState(validPayload, tid, quiet, val as unknown as bigint),
        'nowSeconds',
        'nowSeconds must be a bigint between 0 and U64_MAX',
      );
    }
  });

  it('accepts exact 0n and U64_MAX bigint boundaries for quietSeconds and nowSeconds', () => {
    const res1 = classifyThreadState(validPayload, tid, 0n, now);
    assert.deepStrictEqual(res1, { status: 'Ready' });

    const res2 = classifyThreadState(validPayload, tid, U64_MAX, U64_MAX);
    assert.deepStrictEqual(res2, {
      status: 'Blocked',
      reason: `thread ${tid} is recent: updated_at=50 quiet_seconds=${U64_MAX}`,
    });

    const res3 = classifyThreadState(
      {
        thread: {
          id: tid,
          updatedAt: 0n,
          status: { type: 'idle' },
        },
      },
      tid,
      0n,
      0n,
    );
    assert.deepStrictEqual(res3, { status: 'Ready' });
  });

  it('enforces exact evaluation order: expectedThreadId -> quietSeconds -> nowSeconds -> prior payload', () => {
    let payloadHookCalled = false;
    const trappingPayload = new Proxy({}, {
      get() {
        payloadHookCalled = true;
        throw new Error('payload accessed prematurely');
      },
    });

    // 1. expectedThreadId invalid beats invalid quiet, now, and payload
    assertInvalidClassifierArgument(
      () =>
        classifyThreadState(
          trappingPayload,
          null as unknown as string,
          -1n,
          -1n,
        ),
      'expectedThreadId',
      'expectedThreadId must be a well-formed string',
    );
    assert.strictEqual(payloadHookCalled, false);

    // 2. quietSeconds invalid beats invalid now and payload
    assertInvalidClassifierArgument(
      () =>
        classifyThreadState(
          trappingPayload,
          tid,
          -1n,
          -1n,
        ),
      'quietSeconds',
      'quietSeconds must be a bigint between 0 and U64_MAX',
    );
    assert.strictEqual(payloadHookCalled, false);

    // 3. nowSeconds invalid beats payload
    assertInvalidClassifierArgument(
      () =>
        classifyThreadState(
          trappingPayload,
          tid,
          quiet,
          -1n,
        ),
      'nowSeconds',
      'nowSeconds must be a bigint between 0 and U64_MAX',
    );
    assert.strictEqual(payloadHookCalled, false);

    // 4. valid arguments proceed to payload evaluation (semantic error)
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          null,
          tid,
          quiet,
          now,
        ),
      tid,
      'missing thread object',
    );
  });
});

describe('Thread State Classifier - Raw Wrapper Parse-First Precedence', () => {
  const tid = 'th-rawprec-1';

  it('retains parser native error when rawJson is malformed or non-string, even with invalid arguments', () => {
    // Non-string rawJson throws native TypeError before inspecting arguments
    assert.throws(
      () =>
        classifyThreadStateFromRawJson(
          123 as unknown as string,
          null as unknown as string,
          -1n,
          -1n,
        ),
      (err: unknown) => {
        assert(err instanceof TypeError);
        assert.strictEqual((err as TypeError).message, 'Expected string input');
        assert(!(err instanceof InvalidClassifierArgumentError));
        assert(!(err instanceof InvalidThreadStateError));
        return true;
      },
    );

    // Malformed JSON grammar throws native SyntaxError before inspecting arguments
    assert.throws(
      () =>
        classifyThreadStateFromRawJson(
          '{"thread": { malformed',
          null as unknown as string,
          -1n,
          -1n,
        ),
      (err: unknown) => {
        assert(err instanceof SyntaxError);
        assert(!(err instanceof InvalidClassifierArgumentError));
        assert(!(err instanceof InvalidThreadStateError));
        return true;
      },
    );

    // Lone surrogate in raw string token throws native SyntaxError before inspecting arguments
    assert.throws(
      () =>
        classifyThreadStateFromRawJson(
          '{"thread":{"id":"th-rawprec-1","updatedAt":10,"status":{"type":"idle"}},"extra":"\\uD800"}',
          null as unknown as string,
          -1n,
          -1n,
        ),
      (err: unknown) => {
        assert(err instanceof SyntaxError);
        assert.strictEqual(
          (err as SyntaxError).message,
          'Lone UTF-16 surrogate in string token',
        );
        assert(!(err instanceof InvalidClassifierArgumentError));
        assert(!(err instanceof InvalidThreadStateError));
        return true;
      },
    );
  });

  it('throws typed InvalidClassifierArgumentError when rawJson parses successfully but arguments are invalid', () => {
    const validJson = JSON.stringify({
      thread: {
        id: tid,
        updatedAt: 50,
        status: { type: 'idle' },
      },
    });

    assertInvalidClassifierArgument(
      () =>
        classifyThreadStateFromRawJson(
          validJson,
          null as unknown as string,
          10n,
          100n,
        ),
      'expectedThreadId',
      'expectedThreadId must be a well-formed string',
    );

    assertInvalidClassifierArgument(
      () =>
        classifyThreadStateFromRawJson(
          validJson,
          tid,
          -1n,
          100n,
        ),
      'quietSeconds',
      'quietSeconds must be a bigint between 0 and U64_MAX',
    );

    assertInvalidClassifierArgument(
      () =>
        classifyThreadStateFromRawJson(
          validJson,
          tid,
          10n,
          U64_MAX + 1n,
        ),
      'nowSeconds',
      'nowSeconds must be a bigint between 0 and U64_MAX',
    );
  });
});

describe('Thread State Classifier - Untrusted JS Runtime and Inert Data Defense', () => {
  const tid = 'th-inert-1';
  const now = 100n;
  const quiet = 10n;

  it('rejects changing getter status/type with zero getter calls', () => {
    let typeGetterCalls = 0;
    const statusObj = {};
    Object.defineProperty(statusObj, 'type', {
      get() {
        typeGetterCalls++;
        return typeGetterCalls === 1 ? 'active' : 'idle';
      },
      enumerable: true,
      configurable: true,
    });

    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: statusObj,
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing status type',
    );
    assert.strictEqual(typeGetterCalls, 0, 'getter for type must not be called');

    let statusGetterCalls = 0;
    const threadObj = {
      id: tid,
      updatedAt: 50n,
    };
    Object.defineProperty(threadObj, 'status', {
      get() {
        statusGetterCalls++;
        return { type: 'idle' };
      },
      enumerable: true,
      configurable: true,
    });

    assertInvalidThreadState(
      () =>
        classifyThreadState(
          { thread: threadObj },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing status object',
    );
    assert.strictEqual(statusGetterCalls, 0, 'getter for status must not be called');
  });

  it('rejects accessor descriptors (getters) at root, thread, status, activeFlags, and item layers with zero hooks', () => {
    // 1. root getter for thread
    let rootCalls = 0;
    const root = {};
    Object.defineProperty(root, 'thread', {
      get() {
        rootCalls++;
        return { id: tid, updatedAt: 50n, status: { type: 'idle' } };
      },
      enumerable: true,
    });
    assertInvalidThreadState(
      () => classifyThreadState(root, tid, quiet, now),
      tid,
      'missing thread object',
    );
    assert.strictEqual(rootCalls, 0, 'root thread getter must not be invoked');

    // 2. thread getter for id
    let idCalls = 0;
    const threadWithIdGetter = { updatedAt: 50n, status: { type: 'idle' } };
    Object.defineProperty(threadWithIdGetter, 'id', {
      get() {
        idCalls++;
        return tid;
      },
      enumerable: true,
    });
    assertInvalidThreadState(
      () => classifyThreadState({ thread: threadWithIdGetter }, tid, quiet, now),
      tid,
      'missing thread id',
    );
    assert.strictEqual(idCalls, 0, 'thread id getter must not be invoked');

    // 3. thread getter for updatedAt
    let updatedCalls = 0;
    const threadWithUpdatedGetter = { id: tid, status: { type: 'idle' } };
    Object.defineProperty(threadWithUpdatedGetter, 'updatedAt', {
      get() {
        updatedCalls++;
        return 50n;
      },
      enumerable: true,
    });
    assertInvalidThreadState(
      () => classifyThreadState({ thread: threadWithUpdatedGetter }, tid, quiet, now),
      tid,
      'missing or invalid updatedAt',
    );
    assert.strictEqual(updatedCalls, 0, 'thread updatedAt getter must not be invoked');

    // 4. thread getter for status
    let statusCalls = 0;
    const threadWithStatusGetter = { id: tid, updatedAt: 50n };
    Object.defineProperty(threadWithStatusGetter, 'status', {
      get() {
        statusCalls++;
        return { type: 'idle' };
      },
      enumerable: true,
    });
    assertInvalidThreadState(
      () => classifyThreadState({ thread: threadWithStatusGetter }, tid, quiet, now),
      tid,
      'missing status object',
    );
    assert.strictEqual(statusCalls, 0, 'thread status getter must not be invoked');

    // 5. status getter for type
    let typeCalls = 0;
    const statusWithTypeGetter = {};
    Object.defineProperty(statusWithTypeGetter, 'type', {
      get() {
        typeCalls++;
        return 'idle';
      },
      enumerable: true,
    });
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: statusWithTypeGetter,
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing status type',
    );
    assert.strictEqual(typeCalls, 0, 'status type getter must not be invoked');

    // 6. status getter for activeFlags
    let flagsCalls = 0;
    const statusWithFlagsGetter = { type: 'active' };
    Object.defineProperty(statusWithFlagsGetter, 'activeFlags', {
      get() {
        flagsCalls++;
        return [];
      },
      enumerable: true,
    });
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: statusWithFlagsGetter,
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'active status has no activeFlags array',
    );
    assert.strictEqual(flagsCalls, 0, 'activeFlags getter must not be invoked');

    // 7. activeFlags array getter for flag item
    let itemCalls = 0;
    const flagsWithItemGetter: string[] = [];
    Object.defineProperty(flagsWithItemGetter, '0', {
      get() {
        itemCalls++;
        return 'waitingOnApproval';
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(flagsWithItemGetter, 'length', { value: 1 });
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: {
                type: 'active',
                activeFlags: flagsWithItemGetter,
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'active flag is not text',
    );
    assert.strictEqual(itemCalls, 0, 'flag item getter must not be invoked');
  });

  it('rejects proxies at all layers (including revoked proxies) with zero trap calls', () => {
    // 1. Proxy at root
    let rootTraps = 0;
    const proxyRoot = new Proxy(
      { thread: { id: tid, updatedAt: 50n, status: { type: 'idle' } } },
      {
        get(target, prop, receiver) {
          rootTraps++;
          return Reflect.get(target, prop, receiver);
        },
        getOwnPropertyDescriptor(target, prop) {
          rootTraps++;
          return Reflect.getOwnPropertyDescriptor(target, prop);
        },
        getPrototypeOf(target) {
          rootTraps++;
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    assertInvalidThreadState(
      () => classifyThreadState(proxyRoot, tid, quiet, now),
      tid,
      'missing thread object',
    );
    assert.strictEqual(rootTraps, 0, 'zero traps on root proxy');

    // Revoked proxy at root
    const { proxy: revokedRoot, revoke: revokeRoot } = Proxy.revocable({}, {});
    revokeRoot();
    assertInvalidThreadState(
      () => classifyThreadState(revokedRoot, tid, quiet, now),
      tid,
      'missing thread object',
    );

    // 2. Proxy at thread
    let threadTraps = 0;
    const proxyThread = new Proxy(
      { id: tid, updatedAt: 50n, status: { type: 'idle' } },
      {
        get(target, prop, receiver) {
          threadTraps++;
          return Reflect.get(target, prop, receiver);
        },
        getPrototypeOf(target) {
          threadTraps++;
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    assertInvalidThreadState(
      () => classifyThreadState({ thread: proxyThread }, tid, quiet, now),
      tid,
      'missing thread object',
    );
    assert.strictEqual(threadTraps, 0, 'zero traps on thread proxy');

    // Revoked proxy at thread
    const { proxy: revokedThread, revoke: revokeThread } = Proxy.revocable({}, {});
    revokeThread();
    assertInvalidThreadState(
      () => classifyThreadState({ thread: revokedThread }, tid, quiet, now),
      tid,
      'missing thread object',
    );

    // 3. Proxy at status
    let statusTraps = 0;
    const proxyStatus = new Proxy(
      { type: 'idle' },
      {
        get(target, prop, receiver) {
          statusTraps++;
          return Reflect.get(target, prop, receiver);
        },
        getPrototypeOf(target) {
          statusTraps++;
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: proxyStatus,
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing status object',
    );
    assert.strictEqual(statusTraps, 0, 'zero traps on status proxy');

    // Revoked proxy at status
    const { proxy: revokedStatus, revoke: revokeStatus } = Proxy.revocable({}, {});
    revokeStatus();
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: revokedStatus,
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing status object',
    );

    // 4. Proxy at activeFlags
    let flagsTraps = 0;
    const proxyFlags = new Proxy(
      ['waitingOnApproval'],
      {
        get(target, prop, receiver) {
          flagsTraps++;
          return Reflect.get(target, prop, receiver);
        },
        getPrototypeOf(target) {
          flagsTraps++;
          return Reflect.getPrototypeOf(target);
        },
      },
    );
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: {
                type: 'active',
                activeFlags: proxyFlags,
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'active status has no activeFlags array',
    );
    assert.strictEqual(flagsTraps, 0, 'zero traps on activeFlags proxy');

    // Revoked proxy at activeFlags
    const { proxy: revokedFlags, revoke: revokeFlags } = Proxy.revocable([], {});
    revokeFlags();
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: {
                type: 'active',
                activeFlags: revokedFlags,
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'active status has no activeFlags array',
    );
  });

  it('rejects class instances and graphs at all layers', () => {
    class CustomRoot {
      thread = { id: tid, updatedAt: 50n, status: { type: 'idle' } };
    }
    assertInvalidThreadState(
      () => classifyThreadState(new CustomRoot(), tid, quiet, now),
      tid,
      'missing thread object',
    );

    class CustomThread {
      id = tid;
      updatedAt = 50n;
      status = { type: 'idle' };
    }
    assertInvalidThreadState(
      () => classifyThreadState({ thread: new CustomThread() }, tid, quiet, now),
      tid,
      'missing thread object',
    );

    class CustomStatus {
      type = 'idle';
    }
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: new CustomStatus(),
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing status object',
    );

    class CustomFlagsArray extends Array {}
    const customArray = new CustomFlagsArray();
    customArray.push('waitingOnApproval');
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: {
                type: 'active',
                activeFlags: customArray,
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'active status has no activeFlags array',
    );
  });

  it('rejects prototype-inherited properties across all layers', () => {
    // 1. thread inherited on root
    const rootProto = { thread: { id: tid, updatedAt: 50n, status: { type: 'idle' } } };
    const inheritedRoot = Object.create(rootProto);
    assertInvalidThreadState(
      () => classifyThreadState(inheritedRoot, tid, quiet, now),
      tid,
      'missing thread object',
    );

    // 2. id inherited on thread
    const threadProtoId = { id: tid };
    const threadInheritedId = Object.create(threadProtoId);
    threadInheritedId.updatedAt = 50n;
    threadInheritedId.status = { type: 'idle' };
    assertInvalidThreadState(
      () => classifyThreadState({ thread: threadInheritedId }, tid, quiet, now),
      tid,
      'missing thread object',
    );

    // 3. updatedAt inherited on thread
    const threadProtoUpdated = { updatedAt: 50n };
    const threadInheritedUpdated = Object.create(threadProtoUpdated);
    threadInheritedUpdated.id = tid;
    threadInheritedUpdated.status = { type: 'idle' };
    assertInvalidThreadState(
      () => classifyThreadState({ thread: threadInheritedUpdated }, tid, quiet, now),
      tid,
      'missing thread object',
    );

    // 4. status inherited on thread
    const threadProtoStatus = { status: { type: 'idle' } };
    const threadInheritedStatus = Object.create(threadProtoStatus);
    threadInheritedStatus.id = tid;
    threadInheritedStatus.updatedAt = 50n;
    assertInvalidThreadState(
      () => classifyThreadState({ thread: threadInheritedStatus }, tid, quiet, now),
      tid,
      'missing thread object',
    );

    // 5. type inherited on status
    const statusProtoType = { type: 'idle' };
    const statusInheritedType = Object.create(statusProtoType);
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: statusInheritedType,
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing status object',
    );

    // 6. activeFlags inherited on status
    const statusProtoFlags = { activeFlags: ['waitingOnApproval'] };
    const statusInheritedFlags = Object.create(statusProtoFlags);
    statusInheritedFlags.type = 'active';
    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: statusInheritedFlags,
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      'missing status object',
    );
  });

  it('accepts null-prototype own JSON objects', () => {
    const nullRoot = Object.create(null);
    const nullThread = Object.create(null);
    const nullStatus = Object.create(null);

    nullStatus.type = 'idle';
    nullThread.id = tid;
    nullThread.updatedAt = 50n;
    nullThread.status = nullStatus;
    nullRoot.thread = nullThread;

    const idleRes = classifyThreadState(nullRoot, tid, quiet, now);
    assert.deepStrictEqual(idleRes, { status: 'Ready' });

    const nullActiveStatus = Object.create(null);
    nullActiveStatus.type = 'active';
    nullActiveStatus.activeFlags = ['waitingOnApproval', 'waitingOnUserInput'];
    nullThread.status = nullActiveStatus;

    const activeRes = classifyThreadState(nullRoot, tid, quiet, now);
    assert.deepStrictEqual(activeRes, {
      status: 'Blocked',
      reason: `thread ${tid} is active flags=waitingOnApproval,waitingOnUserInput`,
    });
  });

  it('ensures earlier missing thread id or id mismatch beats later status getter without reading getter', () => {
    let getterCalled = false;
    const threadWithoutId = {
      updatedAt: 50n,
    };
    Object.defineProperty(threadWithoutId, 'status', {
      get() {
        getterCalled = true;
        return { type: 'idle' };
      },
      enumerable: true,
    });

    assertInvalidThreadState(
      () => classifyThreadState({ thread: threadWithoutId }, tid, quiet, now),
      tid,
      'missing thread id',
    );
    assert.strictEqual(getterCalled, false, 'status getter must not be called when id is missing');

    getterCalled = false;
    const threadWithMismatchId = {
      id: 'th-other',
      updatedAt: 50n,
    };
    Object.defineProperty(threadWithMismatchId, 'status', {
      get() {
        getterCalled = true;
        return { type: 'idle' };
      },
      enumerable: true,
    });

    assertInvalidThreadState(
      () => classifyThreadState({ thread: threadWithMismatchId }, tid, quiet, now),
      tid,
      'thread id mismatch',
    );
    assert.strictEqual(getterCalled, false, 'status getter must not be called on id mismatch');
  });

  it('ensures earlier unknown flag beats later getter or non-text in activeFlags', () => {
    let laterGetterCalled = false;
    const flags = ['unknownFlag'];
    Object.defineProperty(flags, '1', {
      get() {
        laterGetterCalled = true;
        return 'waitingOnApproval';
      },
      enumerable: true,
      configurable: true,
    });
    Object.defineProperty(flags, 'length', { value: 2 });

    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: {
                type: 'active',
                activeFlags: flags,
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      `unknown active flag ${rustDebugString('unknownFlag')}`,
    );
    assert.strictEqual(laterGetterCalled, false, 'later flag getter must not be called when earlier flag is unknown');

    assertInvalidThreadState(
      () =>
        classifyThreadState(
          {
            thread: {
              id: tid,
              updatedAt: 50n,
              status: {
                type: 'active',
                activeFlags: ['unknownFlag', 123 as unknown as string],
              },
            },
          },
          tid,
          quiet,
          now,
        ),
      tid,
      `unknown active flag ${rustDebugString('unknownFlag')}`,
    );
  });

  it('does not invoke poisoned Symbol.iterator on activeFlags array', () => {
    let iteratorCalled = false;
    const poisonedFlags = ['waitingOnApproval', 'waitingOnUserInput'];
    Object.defineProperty(poisonedFlags, Symbol.iterator, {
      value: () => {
        iteratorCalled = true;
        throw new Error('poisoned Symbol.iterator called');
      },
      enumerable: false,
      configurable: true,
    });

    const res = classifyThreadState(
      {
        thread: {
          id: tid,
          updatedAt: 50n,
          status: {
            type: 'active',
            activeFlags: poisonedFlags,
          },
        },
      },
      tid,
      quiet,
      now,
    );

    assert.strictEqual(iteratorCalled, false, 'Symbol.iterator must not be invoked');
    assert.deepStrictEqual(res, {
      status: 'Blocked',
      reason: `thread ${tid} is active flags=waitingOnApproval,waitingOnUserInput`,
    });
  });
});
