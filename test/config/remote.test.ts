import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';
import {
  loadRemoteMcpConfig,
  RemoteConfigError,
  ConfigError,
  RemoteMcpConfig,
  SecretToken,
  rustTrim,
  asciiLower,
  parseRustU64,
} from '../../src/config/remote.ts';

function environment(url: string, overrides: Record<string, string> = {}): Map<string, string> {
  const map = new Map<string, string>([
    ['CODEX_REMOTE_MCP_ENABLED', 'true'],
    ['CODEX_REMOTE_MCP_BRIDGE_URL', url],
    ['CODEX_REMOTE_MCP_DEVICE_ID', 'device-a'],
    ['CODEX_REMOTE_MCP_DEVICE_TOKEN', 'device-secret-never-print'],
  ]);
  for (const [k, v] of Object.entries(overrides)) {
    map.set(k, v);
  }
  return map;
}

describe('pure remote config parser contract tests', () => {
  it('cfg1_disabled_is_none_and_secure_or_exact_loopback_urls_pass', () => {
    assert.equal(loadRemoteMcpConfig(new Map()), null);
    assert.equal(ConfigError, RemoteConfigError);

    for (const url of [
      'ws://localhost:8030/bridge',
      'ws://127.0.0.1:8030/bridge',
      'ws://[::1]:8030/bridge',
      'wss://simdorei.duckdns.org/bridge',
    ]) {
      const config = loadRemoteMcpConfig(environment(url));
      assert.ok(config);
      assert.equal(config.bridge_url.href, url);
      assert.equal(config.binding_ttl_seconds, 1800n);
      assert.equal(config.binding_ack_timeout_seconds, 10n);
      assert.equal(config.reconnect_delay_seconds, 2n);
      assert.ok(!util.inspect(config).includes('device-secret-never-print'));
    }
  });

  it('cfg2_deceptive_plaintext_fragments_credentials_and_bad_ttl_fail_closed', () => {
    for (const url of [
      'ws://localhost@evil.example/bridge',
      'ws://localhost.evil.example/bridge',
      'ws://127.0.0.1.evil.example/bridge',
      'ws://[::1]@evil.example/bridge',
      'wss://example.test/bridge#ignored',
      'ws://localhost:8030/bridge#ignored',
    ]) {
      assert.throws(
        () => loadRemoteMcpConfig(environment(url)),
        (err: unknown) => err instanceof RemoteConfigError && err.tag === 'InvalidBridgeUrl'
      );
    }

    const values = environment('wss://example.test/bridge', {
      CODEX_REMOTE_MCP_BINDING_TTL_SECONDS: '59',
    });
    assert.throws(
        () => loadRemoteMcpConfig(values),
        (err: unknown) =>
          err instanceof RemoteConfigError &&
          err.tag === 'InvalidInteger' &&
          err.minimum === 60n &&
          err.maximum === 86400n
      );
  });

  it('cfg3_missing_required_values_never_leak_token_material', () => {
    const values = environment('wss://example.test/bridge', {
      CODEX_REMOTE_MCP_DEVICE_ID: '',
    });
    assert.throws(
      () => loadRemoteMcpConfig(values),
      (err: unknown) => {
        assert.ok(err instanceof RemoteConfigError);
        assert.equal(err.tag, 'Missing');
        const text = String(err);
        assert.ok(text.includes('CODEX_REMOTE_MCP_DEVICE_ID'));
        assert.ok(!text.includes('device-secret-never-print'));
        return true;
      }
    );
  });

  it('helpers_rustTrim_and_asciiLower', () => {
    assert.equal(rustTrim('\u0085\t  hello \r\n\u00a0\u3000\u0085'), 'hello');
    assert.equal(rustTrim('\uFEFFhello\uFEFF'), '\uFEFFhello\uFEFF');
    assert.equal(asciiLower('CODEX_123_TRUE'), 'codex_123_true');
    assert.equal(asciiLower('İstanbul_É'), 'İstanbul_É');
  });

  it('helpers_parseRustU64', () => {
    assert.equal(parseRustU64('0'), 0n);
    assert.equal(parseRustU64('+0'), 0n);
    assert.equal(parseRustU64('1800'), 1800n);
    assert.equal(parseRustU64('+1800'), 1800n);
    assert.equal(parseRustU64('18446744073709551615'), 18446744073709551615n);

    for (const bad of [
      '-0',
      '-1',
      '18446744073709551616',
      '+',
      '',
      ' 1800',
      '1800 ',
      '1.5',
      '1e5',
      '0x10',
      'NaN',
    ]) {
      assert.equal(parseRustU64(bad), null);
    }
  });

  it('disabled_ignores_invalid_inputs', () => {
    for (const enabled of ['', 'false', '0', 'no', 'off', 'FALSE', 'İ']) {
      const values = new Map<string, string>([
        ['CODEX_REMOTE_MCP_ENABLED', enabled],
        ['CODEX_REMOTE_MCP_BRIDGE_URL', 'invalid://url'],
        ['CODEX_REMOTE_MCP_DEVICE_ID', ''],
        ['CODEX_REMOTE_MCP_DEVICE_TOKEN', ''],
        ['CODEX_REMOTE_MCP_BINDING_TTL_SECONDS', '12'],
      ]);
      assert.equal(loadRemoteMcpConfig(values), null);
    }
  });

  it('enabling_tokens_and_unicode_case', () => {
    for (const token of ['1', 'true', 'yes', 'on', 'TRUE', 'Yes', 'ON', 'True']) {
      const values = environment('wss://example.test/bridge', {
        CODEX_REMOTE_MCP_ENABLED: token,
      });
      const cfg = loadRemoteMcpConfig(values);
      assert.ok(cfg);
    }
    const unicodeValues = environment('wss://example.test/bridge', {
      CODEX_REMOTE_MCP_ENABLED: 'İ',
    });
    assert.equal(loadRemoteMcpConfig(unicodeValues), null);
  });

  it('ttl_defaults_limits_and_precedence', () => {
    const defMap = environment('wss://example.test/bridge');
    defMap.delete('CODEX_REMOTE_MCP_BINDING_TTL_SECONDS');
    const defCfg = loadRemoteMcpConfig(defMap);
    assert.ok(defCfg);
    assert.equal(defCfg.binding_ttl_seconds, 1800n);

    const blankMap = environment('wss://example.test/bridge', {
      CODEX_REMOTE_MCP_BINDING_TTL_SECONDS: '   \u0085 ',
    });
    const blankCfg = loadRemoteMcpConfig(blankMap);
    assert.ok(blankCfg);
    assert.equal(blankCfg.binding_ttl_seconds, 1800n);

    const minCfg = loadRemoteMcpConfig(
      environment('wss://example.test/bridge', { CODEX_REMOTE_MCP_BINDING_TTL_SECONDS: '+60' })
    );
    assert.ok(minCfg);
    assert.equal(minCfg.binding_ttl_seconds, 60n);

    const maxCfg = loadRemoteMcpConfig(
      environment('wss://example.test/bridge', { CODEX_REMOTE_MCP_BINDING_TTL_SECONDS: '86400' })
    );
    assert.ok(maxCfg);
    assert.equal(maxCfg.binding_ttl_seconds, 86400n);

    assert.throws(
      () =>
        loadRemoteMcpConfig(
          environment('wss://example.test/bridge', { CODEX_REMOTE_MCP_BINDING_TTL_SECONDS: '86401' })
        ),
      (err: unknown) => err instanceof RemoteConfigError && err.tag === 'InvalidInteger'
    );

    const prec1 = environment('http://not-ws-or-wss', { CODEX_REMOTE_MCP_DEVICE_ID: '' });
    assert.throws(
      () => loadRemoteMcpConfig(prec1),
      (err: unknown) => err instanceof RemoteConfigError && err.tag === 'InvalidBridgeUrl'
    );

    const prec2 = environment('wss://example.test/bridge', {
      CODEX_REMOTE_MCP_DEVICE_ID: '',
      CODEX_REMOTE_MCP_DEVICE_TOKEN: '',
    });
    assert.throws(
      () => loadRemoteMcpConfig(prec2),
      (err: unknown) => err instanceof RemoteConfigError && err.tag === 'Missing' && err.configName === 'CODEX_REMOTE_MCP_DEVICE_ID'
    );

    const prec3 = environment('wss://example.test/bridge', {
      CODEX_REMOTE_MCP_DEVICE_TOKEN: '',
      CODEX_REMOTE_MCP_BINDING_TTL_SECONDS: '10',
    });
    assert.throws(
      () => loadRemoteMcpConfig(prec3),
      (err: unknown) => err instanceof RemoteConfigError && err.tag === 'Missing' && err.configName === 'CODEX_REMOTE_MCP_DEVICE_TOKEN'
    );
  });

  it('url_delimiters_and_empty_credentials', () => {
    assert.throws(
      () => loadRemoteMcpConfig(environment('wss://example.test/bridge#')),
      (err: unknown) => err instanceof RemoteConfigError && err.tag === 'InvalidBridgeUrl'
    );
    assert.throws(
      () => loadRemoteMcpConfig(environment('ws://localhost:8030/bridge#')),
      (err: unknown) => err instanceof RemoteConfigError && err.tag === 'InvalidBridgeUrl'
    );

    const emptyColon = loadRemoteMcpConfig(environment('ws://:@localhost:8030/bridge'));
    assert.ok(emptyColon);
    assert.equal(emptyColon.bridge_url.href, 'ws://localhost:8030/bridge');

    const emptyUserAt = loadRemoteMcpConfig(environment('ws://@localhost:8030/bridge'));
    assert.ok(emptyUserAt);
    assert.equal(emptyUserAt.bridge_url.hostname, 'localhost');

    const unusualIpv4 = loadRemoteMcpConfig(environment('ws://127.1:8030/bridge'));
    assert.ok(unusualIpv4);
    assert.equal(unusualIpv4.bridge_url.hostname, '127.0.0.1');

    const defaultPort = loadRemoteMcpConfig(environment('wss://example.test:443/bridge'));
    assert.ok(defaultPort);
    assert.equal(defaultPort.bridge_url.href, 'wss://example.test/bridge');

    const noSlashWss = loadRemoteMcpConfig(environment('wss:example.test/bridge'));
    assert.ok(noSlashWss);
    assert.equal(noSlashWss.bridge_url.href, 'wss://example.test/bridge');

    const singleSlashWss = loadRemoteMcpConfig(environment('wss:/example.test/bridge'));
    assert.ok(singleSlashWss);
    assert.equal(singleSlashWss.bridge_url.href, 'wss://example.test/bridge');

    const noSlashWs = loadRemoteMcpConfig(environment('ws:localhost:8030/bridge'));
    assert.ok(noSlashWs);
    assert.equal(noSlashWs.bridge_url.href, 'ws://localhost:8030/bridge');

    const backslashSpecial = loadRemoteMcpConfig(environment('wss:\\\\example.test/bridge'));
    assert.ok(backslashSpecial);
    assert.equal(backslashSpecial.bridge_url.href, 'wss://example.test/bridge');

    const percentHash = loadRemoteMcpConfig(environment('wss://example.test/bridge%23test'));
    assert.ok(percentHash);
    assert.equal(percentHash.bridge_url.href, 'wss://example.test/bridge%23test');

    for (const credUrl of [
      'wss://user:pass@example.test/bridge',
      'ws://user@localhost:8030/bridge',
      'ws://:pass@localhost:8030/bridge',
    ]) {
      assert.throws(
        () => loadRemoteMcpConfig(environment(credUrl)),
        (err: unknown) => err instanceof RemoteConfigError && err.tag === 'InvalidBridgeUrl'
      );
    }
  });

  it('record_with_inherited_property_cannot_be_accepted', () => {
    const proto = { CODEX_REMOTE_MCP_ENABLED: 'true' };
    const inherited = Object.create(proto) as unknown as ReadonlyMap<string, string>;
    assert.throws(
      () => loadRemoteMcpConfig(inherited),
      TypeError
    );
  });

  it('secret_token_redaction_and_accessors', () => {
    const token = new SecretToken('device-secret-never-print');
    assert.equal(token.expose(), 'device-secret-never-print');
    assert.equal(util.inspect(token), 'SecretToken([REDACTED])');
    assert.equal(JSON.stringify(token), '"[REDACTED]"');
    assert.equal(token.toString(), 'SecretToken([REDACTED])');
    assert.ok(token.equals(new SecretToken('device-secret-never-print')));
    assert.ok(!token.equals(new SecretToken('other')));

    const cfg = loadRemoteMcpConfig(environment('wss://example.test/bridge'));
    assert.ok(cfg);
    assert.ok(!JSON.stringify(cfg).includes('device-secret-never-print'));
    assert.ok(JSON.stringify(cfg).includes('[REDACTED]'));
    assert.ok(!util.inspect(cfg).includes('device-secret-never-print'));
    assert.ok(util.inspect(cfg).includes('SecretToken([REDACTED])'));
    assert.equal(cfg.deviceId, 'device-a');
    assert.equal(cfg.deviceToken.expose(), 'device-secret-never-print');
    assert.equal(cfg.bindingTtlSeconds, 1800n);
    assert.equal(cfg.bindingAckTimeoutSeconds, 10n);
    assert.equal(cfg.reconnectDelaySeconds, 2n);
  });
});
