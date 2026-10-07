import test from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import {
  loadRuntimeConfig,
  defaultCliOptions,
  mergeEnvText,
  secondsToNanos,
  RuntimeConfigError,
} from '../../src/config/runtime.ts';
import { RemoteConfigError } from '../../src/config/remote.ts';

const RESUME_ENV = 'DISCORD_APP_SERVER_RESUME_TIMEOUT_SECONDS';
const HISTORY_READ_ENV = 'DISCORD_APP_SERVER_HISTORY_READ_TIMEOUT_SECONDS';

function requiredEnv(): Map<string, string> {
  return new Map([
    ['DISCORD_BOT_TOKEN', ' secret-token \n'],
    ['DISCORD_ALLOWED_CHANNEL_IDS', '20, bad, 10,20'],
  ]);
}

test('defaults and id sets match python and rust runtime', () => {
  const config = loadRuntimeConfig(requiredEnv());
  assert.deepEqual(Array.from(config.allowedChannelIds), [10n, 20n]);
  assert.equal(config.startupChannelId, null);
  assert.equal(config.botToken.expose(), 'secret-token');
  assert.equal(config.enableMessageContent, true);
  assert.equal(config.streamCommentary, true);
  assert.equal(config.sessionMirror, true);
  assert.equal(config.qaCommands, false);
  assert.equal(config.hostCommands, false);
  assert.equal(config.startupNotify, false);
  assert.equal(config.attachmentsEnabled, true);
  assert.equal(config.attachmentMaxBytes, 26214400n);
  assert.equal(config.attachmentTextInlineMaxBytes, 32768n);
  assert.equal(config.historyPollIntervalNs, 15000000000n);
  assert.equal(config.appServerResumeTimeoutNs, 60000000000n);
  assert.equal(config.appServerHistoryReadTimeoutNs, 60000000000n);
});

test('history poll interval defaults for blank or invalid values', () => {
  for (const raw of ['', '   ', 'not-a-number', 'NaN', 'inf', '-inf']) {
    const env = requiredEnv();
    env.set('DISCORD_HISTORY_POLL_SECONDS', raw);
    const config = loadRuntimeConfig(env);
    assert.equal(config.historyPollIntervalNs, 15000000000n, `failed for raw: ${raw}`);
  }
});

test('history poll interval clamps and zero explicitly disables polling', () => {
  const cases: [string, bigint | null][] = [
    ['-1', null],
    ['-0.25', null],
    ['-0', null],
    ['0', null],
    ['1e-20', 1n],
    ['0.25', 250000000n],
    ['999', 300000000000n],
  ];
  for (const [raw, expected] of cases) {
    const env = requiredEnv();
    env.set('DISCORD_HISTORY_POLL_SECONDS', raw);
    const config = loadRuntimeConfig(env);
    assert.equal(config.historyPollIntervalNs, expected, `raw value: ${raw}`);
  }
});

test('secondsToNanos exact binary64 ties-to-even rounding vectors', () => {
  const vectors: [number, bigint][] = [
    [1e-20, 0n],
    [0.999e-9, 1n],
    [0.999999999499, 999999999n],
    [0.999999999501, 1000000000n],
    [42.999999999499, 42999999999n],
    [42.999999999501, 43000000000n],
    [1 / 1024, 976562n],
    [3 / 1024, 2929688n],
    [1 + 1 / 1024, 1000976562n],
    [1 + 3 / 1024, 1002929688n],
  ];
  for (const [sec, expected] of vectors) {
    assert.equal(secondsToNanos(sec), expected, `seconds: ${sec}`);
  }
});

test('attachment limits match defaults, bounds, and i128 overflow fallback', () => {
  const env = requiredEnv();
  env.set('DISCORD_ENABLE_ATTACHMENTS', 'off');
  env.set('DISCORD_ATTACHMENT_MAX_BYTES', '999999999');
  env.set('DISCORD_ATTACHMENT_TEXT_INLINE_MAX_BYTES', '-1');
  let config = loadRuntimeConfig(env);
  assert.equal(config.attachmentsEnabled, false);
  assert.equal(config.attachmentMaxBytes, 104857600n);
  assert.equal(config.attachmentTextInlineMaxBytes, 0n);

  const envOverflow = requiredEnv();
  envOverflow.set('DISCORD_ATTACHMENT_MAX_BYTES', '170141183460469231731687303715884105728');
  envOverflow.set('DISCORD_ATTACHMENT_TEXT_INLINE_MAX_BYTES', '-170141183460469231731687303715884105729');
  config = loadRuntimeConfig(envOverflow);
  assert.equal(config.attachmentMaxBytes, 26214400n);
  assert.equal(config.attachmentTextInlineMaxBytes, 32768n);
});

test('sole allowed channel is default startup channel', () => {
  const env = requiredEnv();
  env.set('DISCORD_ALLOWED_CHANNEL_IDS', '44');
  const config = loadRuntimeConfig(env);
  assert.equal(config.startupChannelId, 44n);
});

test('explicit startup channel and optional ids are loaded', () => {
  const env = requiredEnv();
  env.set('DISCORD_STARTUP_CHANNEL_ID', '99');
  env.set('DISCORD_GUILD_ID', '77');
  env.set('DISCORD_ALLOWED_USER_IDS', '8,9');
  env.set('DISCORD_PLAIN_ASK_MENTION_USER_IDS', '6');
  const config = loadRuntimeConfig(env);
  assert.equal(config.startupChannelId, 99n);
  assert.equal(config.guildId, 77n);
  assert.deepEqual(Array.from(config.allowedUserIds), [8n, 9n]);
  assert.deepEqual(Array.from(config.plainAskMentionUserIds), [6n]);
});

test('missing token and missing channel gate fail without secret output', () => {
  assert.throws(
    () => loadRuntimeConfig(new Map()),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeConfigError);
      assert.equal(err.tag, 'MissingRequired');
      assert.equal(err.name, 'DISCORD_BOT_TOKEN');
      assert.equal(err.message, 'missing required environment variable: DISCORD_BOT_TOKEN');
      return true;
    }
  );

  const env = new Map([['DISCORD_BOT_TOKEN', 'very-secret-token']]);
  assert.throws(
    () => loadRuntimeConfig(env),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeConfigError);
      assert.equal(err.tag, 'MissingAllowedChannels');
      assert.equal(
        err.message,
        'set DISCORD_ALLOWED_CHANNEL_IDS or DISCORD_ALLOW_ALL_CHANNELS=1'
      );
      assert.ok(!util.inspect(err).includes('very-secret-token'));
      return true;
    }
  );
});

test('allow all channels is explicit opt in', () => {
  const env = new Map([
    ['DISCORD_BOT_TOKEN', 'token'],
    ['DISCORD_ALLOW_ALL_CHANNELS', 'yes'],
  ]);
  const config = loadRuntimeConfig(env);
  assert.equal(config.allowAllChannels, true);
  assert.equal(config.allowedChannelIds.size, 0);
});

test('flags truthy/falsey rules and cli overrides message content', () => {
  const env = requiredEnv();
  env.set('DISCORD_ENABLE_QA_COMMANDS', 'yes');
  env.set('DISCORD_ENABLE_HOST_COMMANDS', '1');
  env.set('DISCORD_STREAM_COMMENTARY', 'off');
  env.set('DISCORD_STARTUP_NOTIFY', 'true');
  env.set('DISCORD_SESSION_MIRROR', 'no');
  const config = loadRuntimeConfig(env, {
    noMessageContent: true,
    checkConfig: false,
  });
  assert.equal(config.qaCommands, true);
  assert.equal(config.hostCommands, true);
  assert.equal(config.streamCommentary, false);
  assert.equal(config.startupNotify, true);
  assert.equal(config.sessionMirror, false);
  assert.equal(config.enableMessageContent, false);
});

test('env message content flag can disable prefix and plain messages', () => {
  const env = requiredEnv();
  env.set('DISCORD_ENABLE_MESSAGE_CONTENT', '0');
  const config = loadRuntimeConfig(env);
  assert.equal(config.enableMessageContent, false);
});

test('mergeEnvText quote order, first equals, and preservation semantics', () => {
  const env = new Map([['EXISTING', 'process']]);
  mergeEnvText(
    env,
    '# ignored\n TOKEN = from-file\nDOUBLE = "quoted"\nSINGLE=\'single\'\nNESTED="\'both\'"\nNO_EQUALS\nEXISTING=file\nMULTI=a=b=c\n\u0085NEL_KEY\u0085=nel_val'
  );
  assert.equal(env.get('TOKEN'), 'from-file');
  assert.equal(env.get('DOUBLE'), 'quoted');
  assert.equal(env.get('SINGLE'), 'single');
  assert.equal(env.get('NESTED'), 'both');
  assert.equal(env.get('EXISTING'), 'process');
  assert.equal(env.get('MULTI'), 'a=b=c');
  assert.equal(env.get('NEL_KEY'), 'nel_val');
  assert.equal(env.has('NO_EQUALS'), false);
});

test('invalid scalar ids surface variable name', () => {
  const env = requiredEnv();
  env.set('DISCORD_GUILD_ID', 'not-an-id');
  assert.throws(
    () => loadRuntimeConfig(env),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeConfigError);
      assert.equal(err.tag, 'InvalidInteger');
      assert.equal(err.name, 'DISCORD_GUILD_ID');
      assert.equal(err.message, 'invalid integer in environment variable: DISCORD_GUILD_ID');
      return true;
    }
  );
});

test('token is always redacted in inspect and toJSON', () => {
  const config = loadRuntimeConfig(requiredEnv());
  const debug = util.inspect(config);
  assert.ok(debug.includes('[REDACTED]'));
  assert.ok(!debug.includes('secret-token'));
  assert.equal(config.botToken.toJSON(), '[REDACTED]');
  assert.equal(config.botToken.toString(), '[REDACTED]');
});

test('enabled remote mcp is validated, loaded, and token is redacted', () => {
  const env = requiredEnv();
  env.set('CODEX_REMOTE_MCP_ENABLED', '1');
  env.set('CODEX_REMOTE_MCP_BRIDGE_URL', 'wss://gateway.example.test/bridge');
  env.set('CODEX_REMOTE_MCP_DEVICE_ID', 'device-a');
  env.set('CODEX_REMOTE_MCP_DEVICE_TOKEN', 'remote-secret-token');
  const config = loadRuntimeConfig(env);
  assert.equal(config.remoteMcp?.deviceId, 'device-a');
  const debug = util.inspect(config);
  assert.ok(!debug.includes('remote-secret-token'));
});

test('app server timeouts default to sixty seconds when unset or blank', () => {
  for (const [name, raw] of [
    [RESUME_ENV, ''],
    [HISTORY_READ_ENV, '   '],
  ] as const) {
    const env = requiredEnv();
    env.set(name, raw);
    const config = loadRuntimeConfig(env);
    assert.equal(config.appServerResumeTimeoutNs, 60000000000n);
    assert.equal(config.appServerHistoryReadTimeoutNs, 60000000000n);
  }
});

test('app server timeouts accept inclusive boundaries and independent values', () => {
  const env = requiredEnv();
  env.set(RESUME_ENV, '10');
  env.set(HISTORY_READ_ENV, '300');
  const config = loadRuntimeConfig(env);
  assert.equal(config.appServerResumeTimeoutNs, 10000000000n);
  assert.equal(config.appServerHistoryReadTimeoutNs, 300000000000n);
});

test('malformed app server timeout is rejected with variable name', () => {
  for (const [name, raw] of [
    [RESUME_ENV, 'not-a-number'],
    [HISTORY_READ_ENV, '10.5'],
    [RESUME_ENV, '-1'],
    [HISTORY_READ_ENV, '1e1'],
  ] as const) {
    const env = requiredEnv();
    env.set(name, raw);
    assert.throws(
      () => loadRuntimeConfig(env),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.equal(err.tag, 'InvalidDurationSeconds');
        assert.equal(err.name, name);
        assert.equal(err.message, `invalid duration seconds in environment variable: ${name}`);
        return true;
      }
    );
  }
});

test('out of range app server timeout is rejected with range properties', () => {
  for (const [name, raw] of [
    [RESUME_ENV, '9'],
    [HISTORY_READ_ENV, '301'],
  ] as const) {
    const env = requiredEnv();
    env.set(name, raw);
    assert.throws(
      () => loadRuntimeConfig(env),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeConfigError);
        assert.equal(err.tag, 'DurationSecondsOutOfRange');
        assert.equal(err.name, name);
        assert.equal(err.min, 10n);
        assert.equal(err.max, 300n);
        assert.equal(
          err.message,
          `duration seconds in environment variable ${name} must be between 10 and 300 inclusive`
        );
        return true;
      }
    );
  }
});

test('adversarial lossless u64 IDs, prefixes, and skip filtering', () => {
  const env = requiredEnv();
  env.set(
    'DISCORD_ALLOWED_CHANNEL_IDS',
    '9007199254740993, 18446744073709551615, +42, 18446744073709551616, -0, junk'
  );
  const config = loadRuntimeConfig(env);
  assert.deepEqual(Array.from(config.allowedChannelIds), [
    42n,
    9007199254740993n,
    18446744073709551615n,
  ]);
});

test('error order: required bot token -> channel gate -> startup -> remote -> guild -> duration', () => {
  const env1 = new Map<string, string>();
  assert.throws(() => loadRuntimeConfig(env1), { tag: 'MissingRequired' });

  const env2 = new Map([['DISCORD_BOT_TOKEN', 'token']]);
  assert.throws(() => loadRuntimeConfig(env2), { tag: 'MissingAllowedChannels' });

  const env3 = new Map([
    ['DISCORD_BOT_TOKEN', 'token'],
    ['DISCORD_ALLOW_ALL_CHANNELS', '1'],
    ['DISCORD_STARTUP_CHANNEL_ID', 'bad-startup'],
    ['CODEX_REMOTE_MCP_ENABLED', '1'],
    ['DISCORD_GUILD_ID', 'bad-guild'],
  ]);
  assert.throws(() => loadRuntimeConfig(env3), {
    tag: 'InvalidInteger',
    name: 'DISCORD_STARTUP_CHANNEL_ID',
  });

  const env4 = new Map([
    ['DISCORD_BOT_TOKEN', 'token'],
    ['DISCORD_ALLOW_ALL_CHANNELS', '1'],
    ['CODEX_REMOTE_MCP_ENABLED', '1'],
    ['DISCORD_GUILD_ID', 'bad-guild'],
  ]);
  assert.throws(() => loadRuntimeConfig(env4), (err: unknown) => err instanceof RemoteConfigError);

  const env5 = new Map([
    ['DISCORD_BOT_TOKEN', 'token'],
    ['DISCORD_ALLOW_ALL_CHANNELS', '1'],
    ['DISCORD_GUILD_ID', 'bad-guild'],
    [RESUME_ENV, 'bad-duration'],
  ]);
  assert.throws(() => loadRuntimeConfig(env5), {
    tag: 'InvalidInteger',
    name: 'DISCORD_GUILD_ID',
  });

  const env6 = new Map([
    ['DISCORD_BOT_TOKEN', 'token'],
    ['DISCORD_ALLOW_ALL_CHANNELS', '1'],
    [RESUME_ENV, '9'],
    [HISTORY_READ_ENV, '301'],
  ]);
  assert.throws(() => loadRuntimeConfig(env6), {
    tag: 'DurationSecondsOutOfRange',
    name: RESUME_ENV,
  });
});

test('input env map is never mutated by loadRuntimeConfig', () => {
  const env = requiredEnv();
  const sizeBefore = env.size;
  loadRuntimeConfig(env, defaultCliOptions());
  assert.equal(env.size, sizeBefore);
});
