import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CliError,
  configSummary,
  defaultEnvPath,
  helpText,
  parseStartupArgs,
  planStartup,
} from '../../src/cli/startup.ts';

test('parseStartupArgs returns defaults for empty argv', () => {
  const parsed = parseStartupArgs([]);
  assert.deepEqual(parsed, {
    cli: { noMessageContent: false, checkConfig: false },
    envPath: null,
    backupStore: false,
    restartReadiness: false,
    restartQuietSeconds: 90n,
    restartWaitTimeoutSeconds: 900n,
    help: false,
  });
});

test('parseStartupArgs parses individual flags and aliases', () => {
  assert.equal(parseStartupArgs(['--no-message-content']).cli.noMessageContent, true);
  assert.equal(parseStartupArgs(['--check-config']).cli.checkConfig, true);
  assert.equal(parseStartupArgs(['--backup-store']).backupStore, true);
  assert.equal(parseStartupArgs(['--restart-readiness']).restartReadiness, true);
  assert.equal(parseStartupArgs(['-h']).help, true);
  assert.equal(parseStartupArgs(['--help']).help, true);
});

test('parseStartupArgs parses timing options and repeated flags', () => {
  const parsed = parseStartupArgs([
    '--restart-quiet-seconds',
    '45',
    '--restart-wait-timeout-seconds',
    '120',
    '--restart-readiness',
  ]);
  assert.equal(parsed.restartQuietSeconds, 45n);
  assert.equal(parsed.restartWaitTimeoutSeconds, 120n);
  assert.equal(parsed.restartReadiness, true);

  const repeated = parseStartupArgs([
    '--restart-readiness',
    '--restart-quiet-seconds',
    '10',
    '--restart-quiet-seconds',
    '25',
    '--env',
    'a.env',
    '--env',
    'b.env',
  ]);
  assert.equal(repeated.restartQuietSeconds, 25n);
  assert.equal(repeated.envPath, 'b.env');
});

test('parseStartupArgs parses u64 edge cases (plus prefix, max u64, unsafe integers)', () => {
  const parsed = parseStartupArgs([
    '--restart-readiness',
    '--restart-quiet-seconds',
    '+0',
    '--restart-wait-timeout-seconds',
    '18446744073709551615',
  ]);
  assert.equal(parsed.restartQuietSeconds, 0n);
  assert.equal(parsed.restartWaitTimeoutSeconds, 18446744073709551615n);

  const unsafeInt = parseStartupArgs([
    '--restart-readiness',
    '--restart-quiet-seconds',
    '9007199254740993',
  ]);
  assert.equal(unsafeInt.restartQuietSeconds, 9007199254740993n);
});

test('parseStartupArgs rejects invalid u64 timings', () => {
  const invalid = ['-0', '-1', '10.5', '1e5', ' 10', '10 ', '18446744073709551616', 'abc'];
  for (const raw of invalid) {
    assert.throws(
      () => parseStartupArgs(['--restart-readiness', '--restart-quiet-seconds', raw]),
      (err) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.variant, 'InvalidSeconds');
        assert.equal(err.message, `invalid non-negative integer after --restart-quiet-seconds: ${raw}`);
        return true;
      }
    );
  }
});

test('parseStartupArgs handles --env consumption, lone surrogate path and missing path', () => {
  const consumed = parseStartupArgs(['--env', '--help']);
  assert.equal(consumed.envPath, '--help');
  assert.equal(consumed.help, false);

  const surrogate = '\uD800';
  const envPreserved = parseStartupArgs(['--env', surrogate]);
  assert.equal(envPreserved.envPath, surrogate);

  assert.throws(
    () => parseStartupArgs(['--env']),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.variant, 'MissingEnvPath');
      assert.equal(err.message, 'missing path after --env');
      return true;
    }
  );
});

test('parseStartupArgs rejects invalid UTF-16 in flag and timing value', () => {
  const surrogate = '\uD800';
  assert.throws(
    () => parseStartupArgs([surrogate]),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.variant, 'InvalidUtf8');
      assert.equal(err.message, 'argument is not valid UTF-8');
      return true;
    }
  );

  assert.throws(
    () => parseStartupArgs(['--restart-readiness', '--restart-quiet-seconds', surrogate]),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.variant, 'InvalidUtf8');
      return true;
    }
  );
});

test('parseStartupArgs verifies missing value and unknown argument precedence', () => {
  assert.throws(
    () => parseStartupArgs(['--restart-quiet-seconds']),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.variant, 'MissingValue');
      assert.equal(err.message, 'missing value after --restart-quiet-seconds');
      return true;
    }
  );

  assert.throws(
    () => parseStartupArgs(['--restart-quiet-seconds', '10', '--unknown-flag']),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.variant, 'Unknown');
      assert.equal(err.message, 'unknown argument: --unknown-flag');
      return true;
    }
  );
});

test('parseStartupArgs checks restart timing without readiness at the end', () => {
  assert.throws(
    () => parseStartupArgs(['--restart-quiet-seconds', '10']),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.variant, 'RestartOptionsWithoutReadiness');
      assert.equal(err.message, 'restart timing options require --restart-readiness');
      return true;
    }
  );

  assert.throws(
    () => parseStartupArgs(['--help', '--restart-wait-timeout-seconds', '30']),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.variant, 'RestartOptionsWithoutReadiness');
      return true;
    }
  );
});

test('planStartup implements admin bypass with detached arg copy', () => {
  const input = ['--admin', 'run', '--target', 'guild'];
  const plan = planStartup(input);
  assert.equal(plan.kind, 'admin');
  assert.equal(plan.args, null);
  assert.deepEqual(plan.adminArgs, ['run', '--target', 'guild']);
  assert.equal(plan.requiresEnvironment, false);
  assert.equal(plan.requiresConfig, false);

  // Verify detached copy
  input.push('--mutated');
  assert.deepEqual(plan.adminArgs, ['run', '--target', 'guild']);
});

test('planStartup treats admin not first as unknown startup flag', () => {
  assert.throws(
    () => planStartup(['--help', '--admin']),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.variant, 'Unknown');
      assert.equal(err.message, 'unknown argument: --admin');
      return true;
    }
  );
});

test('planStartup evaluates precedence help > restartReadiness > checkConfig > backupStore > gateway', () => {
  const helpPlan = planStartup(['--help', '--restart-readiness', '--check-config', '--backup-store']);
  assert.equal(helpPlan.kind, 'help');
  assert.equal(helpPlan.requiresEnvironment, false);
  assert.equal(helpPlan.requiresConfig, false);

  const restartPlan = planStartup(['--restart-readiness', '--check-config', '--backup-store']);
  assert.equal(restartPlan.kind, 'restartReadiness');
  assert.equal(restartPlan.requiresEnvironment, true);
  assert.equal(restartPlan.requiresConfig, false);

  const checkPlan = planStartup(['--check-config', '--backup-store']);
  assert.equal(checkPlan.kind, 'checkConfig');
  assert.equal(checkPlan.requiresEnvironment, true);
  assert.equal(checkPlan.requiresConfig, true);

  const backupPlan = planStartup(['--backup-store']);
  assert.equal(backupPlan.kind, 'backupStore');
  assert.equal(backupPlan.requiresEnvironment, true);
  assert.equal(backupPlan.requiresConfig, true);

  const gatewayPlan = planStartup([]);
  assert.equal(gatewayPlan.kind, 'gateway');
  assert.equal(gatewayPlan.requiresEnvironment, true);
  assert.equal(gatewayPlan.requiresConfig, true);
});

test('configSummary formats ordered sets, null guild and never accesses botToken', () => {
  let tokenRead = false;
  const input = {
    guildId: null,
    allowedChannelIds: new Set([200n, 100n]),
    allowedUserIds: new Set([20n, 10n, 30n]),
    enableMessageContent: false,
    qaCommands: true,
    get botToken(): string {
      tokenRead = true;
      throw new Error('botToken must not be read');
    },
  };

  const summary = configSummary(input);
  assert.equal(tokenRead, false);
  assert.equal(
    summary,
    'config_valid token=[REDACTED] guild=- channels={100, 200} users={10, 20, 30} message_content=false qa_commands=true'
  );

  const withGuild = configSummary({
    guildId: 123456789012345678n,
    allowedChannelIds: new Set<bigint>(),
    allowedUserIds: new Set<bigint>(),
    enableMessageContent: true,
    qaCommands: false,
  });
  assert.equal(
    withGuild,
    'config_valid token=[REDACTED] guild=123456789012345678 channels={} users={} message_content=true qa_commands=false'
  );
});

test('helpText returns expected options and branding', () => {
  const text = helpText();
  assert.ok(text.startsWith('Codex Discord Remote TypeScript runtime\n\nOptions:'));
  assert.ok(text.includes('--no-message-content'));
  assert.ok(text.includes('--check-config'));
  assert.ok(text.includes('--backup-store'));
  assert.ok(text.includes('--restart-readiness'));
  assert.ok(text.includes('--restart-quiet-seconds N'));
  assert.ok(text.includes('--restart-wait-timeout-seconds N'));
  assert.ok(text.includes('--env PATH'));
  assert.ok(text.includes('-h, --help'));
});

test('defaultEnvPath computes Windows .env path without I/O', () => {
  assert.equal(defaultEnvPath('C:\\app\\bin\\runtime.exe'), 'C:\\app\\bin\\.env');
  assert.equal(defaultEnvPath('C:\\runtime.exe'), 'C:\\.env');
  assert.equal(defaultEnvPath('runtime.exe'), '.env');
  assert.equal(defaultEnvPath(''), '.env');
  assert.equal(defaultEnvPath('C:'), '.env');
  assert.equal(defaultEnvPath('C:\\'), '.env');
  assert.equal(defaultEnvPath('\\'), '.env');
  assert.equal(defaultEnvPath(String.raw`\\server\share`), '.env');
  assert.equal(defaultEnvPath(String.raw`\\server\share\runtime.exe`), String.raw`\\server\share\.env`);
  assert.equal(defaultEnvPath('\\server\\share\\runtime.exe'), '\\server\\share\\.env');
});
