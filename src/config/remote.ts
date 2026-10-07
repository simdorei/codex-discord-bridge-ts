import util from 'node:util';

export const U64_MAX = 18446744073709551615n;

const RUST_WS_CHARS =
  '\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000';
const RUST_WS_START = new RegExp(`^[${RUST_WS_CHARS}]+`, 'u');
const RUST_WS_END = new RegExp(`[${RUST_WS_CHARS}]+$`, 'u');

export function rustTrim(s: string): string {
  return s.replace(RUST_WS_START, '').replace(RUST_WS_END, '');
}

export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export function parseRustU64(raw: string): bigint | null {
  if (!/^\+?[0-9]+$/.test(raw)) {
    return null;
  }
  const digits = raw.startsWith('+') ? raw.slice(1) : raw;
  try {
    const val = BigInt(digits);
    if (val >= 0n && val <= U64_MAX) {
      return val;
    }
    return null;
  } catch {
    return null;
  }
}

export class SecretToken {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  expose(): string {
    return this.#value;
  }

  equals(other: unknown): boolean {
    if (other instanceof SecretToken) {
      return this.#value === other.expose();
    }
    return false;
  }

  [util.inspect.custom](_depth?: number, _options?: util.InspectOptionsStylized): string {
    return 'SecretToken([REDACTED])';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return 'SecretToken([REDACTED])';
  }
}

export type RemoteConfigErrorKind = 'Missing' | 'InvalidBridgeUrl' | 'InvalidInteger';

export class RemoteConfigError extends Error {
  readonly tag: RemoteConfigErrorKind;
  readonly type: RemoteConfigErrorKind;
  readonly kind: RemoteConfigErrorKind;
  readonly configName?: string | undefined;
  readonly paramName?: string | undefined;
  readonly minimum?: bigint | undefined;
  readonly maximum?: bigint | undefined;

  constructor(tag: 'Missing', details: { name: string });
  constructor(tag: 'InvalidBridgeUrl');
  constructor(tag: 'InvalidInteger', details: { name: string; minimum: bigint; maximum: bigint });
  constructor(
    tag: RemoteConfigErrorKind,
    details?: { name?: string; minimum?: bigint; maximum?: bigint }
  ) {
    let message: string;
    if (tag === 'Missing') {
      message = `${details?.name} is required when remote MCP is enabled.`;
    } else if (tag === 'InvalidBridgeUrl') {
      message = 'CODEX_REMOTE_MCP_BRIDGE_URL must use wss:// (ws:// is allowed only for localhost).';
    } else {
      message = `${details?.name} must be an integer between ${details?.minimum} and ${details?.maximum}.`;
    }
    super(message);
    this.name = 'RemoteConfigError';
    this.tag = tag;
    this.type = tag;
    this.kind = tag;
    if (details?.name !== undefined) {
      this.configName = details.name;
      this.paramName = details.name;
    }
    if (details?.minimum !== undefined) {
      this.minimum = details.minimum;
    }
    if (details?.maximum !== undefined) {
      this.maximum = details.maximum;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static missing(name: string): RemoteConfigError {
    return new RemoteConfigError('Missing', { name });
  }

  static invalidBridgeUrl(): RemoteConfigError {
    return new RemoteConfigError('InvalidBridgeUrl');
  }

  static invalidInteger(name: string, minimum: bigint, maximum: bigint): RemoteConfigError {
    return new RemoteConfigError('InvalidInteger', { name, minimum, maximum });
  }
}

export { RemoteConfigError as ConfigError };

export class RemoteMcpConfig {
  readonly bridge_url: URL;
  readonly device_id: string;
  readonly device_token: SecretToken;
  readonly binding_ttl_seconds: bigint;
  readonly binding_ack_timeout_seconds: bigint;
  readonly reconnect_delay_seconds: bigint;

  constructor(init: {
    bridge_url: URL;
    device_id: string;
    device_token: SecretToken;
    binding_ttl_seconds: bigint;
    binding_ack_timeout_seconds?: bigint;
    reconnect_delay_seconds?: bigint;
  }) {
    this.bridge_url = init.bridge_url;
    this.device_id = init.device_id;
    this.device_token = init.device_token;
    this.binding_ttl_seconds = init.binding_ttl_seconds;
    this.binding_ack_timeout_seconds = init.binding_ack_timeout_seconds ?? 10n;
    this.reconnect_delay_seconds = init.reconnect_delay_seconds ?? 2n;
  }

  get bridgeUrl(): URL {
    return this.bridge_url;
  }

  get deviceId(): string {
    return this.device_id;
  }

  get deviceToken(): SecretToken {
    return this.device_token;
  }

  get bindingTtlSeconds(): bigint {
    return this.binding_ttl_seconds;
  }

  get bindingAckTimeoutSeconds(): bigint {
    return this.binding_ack_timeout_seconds;
  }

  get reconnectDelaySeconds(): bigint {
    return this.reconnect_delay_seconds;
  }

  [util.inspect.custom](_depth?: number, _options?: util.InspectOptionsStylized): string {
    return `RemoteMcpConfig { bridge_url: ${this.bridge_url.href}, device_id: '${this.device_id}', device_token: SecretToken([REDACTED]), binding_ttl_seconds: ${this.binding_ttl_seconds}n, binding_ack_timeout_seconds: ${this.binding_ack_timeout_seconds}n, reconnect_delay_seconds: ${this.reconnect_delay_seconds}n }`;
  }

  toJSON(): Record<string, unknown> {
    return {
      bridge_url: this.bridge_url.href,
      device_id: this.device_id,
      device_token: this.device_token.toJSON(),
      binding_ttl_seconds: this.binding_ttl_seconds.toString(),
      binding_ack_timeout_seconds: this.binding_ack_timeout_seconds.toString(),
      reconnect_delay_seconds: this.reconnect_delay_seconds.toString(),
    };
  }
}

function getMapValue(
  values: ReadonlyMap<string, string>,
  key: string
): string | undefined {
  return values.get(key);
}

function required(
  values: ReadonlyMap<string, string>,
  name: string
): string {
  const raw = getMapValue(values, name);
  if (raw === undefined) {
    throw RemoteConfigError.missing(name);
  }
  const trimmed = rustTrim(raw);
  if (trimmed === '') {
    throw RemoteConfigError.missing(name);
  }
  return trimmed;
}

function isSecureBridgeUrl(rawUrl: string, parsed: URL): boolean {
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    return false;
  }
  if (!parsed.hostname) {
    return false;
  }
  if (rawUrl.includes('#') || parsed.hash !== '') {
    return false;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return false;
  }

  if (parsed.protocol === 'wss:') {
    return true;
  }

  const host = asciiLower(parsed.hostname);
  return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
}

function boundedInteger(
  values: ReadonlyMap<string, string>,
  name: string,
  defaultValue: bigint,
  minimum: bigint,
  maximum: bigint
): bigint {
  const raw = getMapValue(values, name);
  if (raw === undefined) {
    return defaultValue;
  }
  const trimmed = rustTrim(raw);
  if (trimmed === '') {
    return defaultValue;
  }
  const parsed = parseRustU64(trimmed);
  if (parsed === null || parsed < minimum || parsed > maximum) {
    throw RemoteConfigError.invalidInteger(name, minimum, maximum);
  }
  return parsed;
}

export function loadRemoteMcpConfig(
  values: ReadonlyMap<string, string>
): RemoteMcpConfig | null {
  const rawEnabled = getMapValue(values, 'CODEX_REMOTE_MCP_ENABLED') ?? '';
  const enabled = asciiLower(rustTrim(rawEnabled));
  if (enabled !== '1' && enabled !== 'true' && enabled !== 'yes' && enabled !== 'on') {
    return null;
  }

  const rawUrl = required(values, 'CODEX_REMOTE_MCP_BRIDGE_URL');
  let bridgeUrl: URL;
  try {
    bridgeUrl = new URL(rawUrl);
  } catch {
    throw RemoteConfigError.invalidBridgeUrl();
  }
  if (!isSecureBridgeUrl(rawUrl, bridgeUrl)) {
    throw RemoteConfigError.invalidBridgeUrl();
  }

  const deviceId = required(values, 'CODEX_REMOTE_MCP_DEVICE_ID');
  const rawToken = required(values, 'CODEX_REMOTE_MCP_DEVICE_TOKEN');
  const deviceToken = new SecretToken(rawToken);

  const bindingTtlSeconds = boundedInteger(
    values,
    'CODEX_REMOTE_MCP_BINDING_TTL_SECONDS',
    1800n,
    60n,
    86400n
  );

  return new RemoteMcpConfig({
    bridge_url: bridgeUrl,
    device_id: deviceId,
    device_token: deviceToken,
    binding_ttl_seconds: bindingTtlSeconds,
    binding_ack_timeout_seconds: 10n,
    reconnect_delay_seconds: 2n,
  });
}
