import util from 'node:util';
import {
  rustTrim,
  asciiLower,
  parseRustU64,
  loadRemoteMcpConfig,
  type RemoteMcpConfig,
} from './remote.ts';

export interface CliOptions {
  readonly noMessageContent: boolean;
  readonly checkConfig: boolean;
}

export function defaultCliOptions(): CliOptions {
  return {
    noMessageContent: false,
    checkConfig: false,
  };
}

export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  expose(): string {
    return this.#value;
  }

  [util.inspect.custom](_depth?: number, _options?: util.InspectOptionsStylized): string {
    return '[REDACTED]';
  }

  toJSON(): string {
    return '[REDACTED]';
  }

  toString(): string {
    return '[REDACTED]';
  }
}

export type RuntimeConfigErrorKind =
  | 'MissingRequired'
  | 'MissingAllowedChannels'
  | 'InvalidInteger'
  | 'InvalidDurationSeconds'
  | 'DurationSecondsOutOfRange';

export class RuntimeConfigError extends Error {
  readonly tag: RuntimeConfigErrorKind;
  readonly type: RuntimeConfigErrorKind;
  readonly kind: RuntimeConfigErrorKind;
  override readonly name: string;
  readonly varName?: string | undefined;
  readonly configName?: string | undefined;
  readonly min?: bigint | undefined;
  readonly max?: bigint | undefined;
  readonly minimum?: bigint | undefined;
  readonly maximum?: bigint | undefined;

  constructor(
    tag: RuntimeConfigErrorKind,
    details?: { name?: string; minimum?: bigint; maximum?: bigint }
  ) {
    let message: string;
    switch (tag) {
      case 'MissingRequired':
        message = `missing required environment variable: ${details?.name ?? ''}`;
        break;
      case 'MissingAllowedChannels':
        message = 'set DISCORD_ALLOWED_CHANNEL_IDS or DISCORD_ALLOW_ALL_CHANNELS=1';
        break;
      case 'InvalidInteger':
        message = `invalid integer in environment variable: ${details?.name ?? ''}`;
        break;
      case 'InvalidDurationSeconds':
        message = `invalid duration seconds in environment variable: ${details?.name ?? ''}`;
        break;
      case 'DurationSecondsOutOfRange':
        message = `duration seconds in environment variable ${details?.name ?? ''} must be between ${details?.minimum?.toString() ?? ''} and ${details?.maximum?.toString() ?? ''} inclusive`;
        break;
    }
    super(message);
    this.tag = tag;
    this.type = tag;
    this.kind = tag;
    if (details?.name !== undefined) {
      this.name = details.name;
      this.varName = details.name;
      this.configName = details.name;
    } else {
      this.name = 'RuntimeConfigError';
    }
    if (details?.minimum !== undefined) {
      this.min = details.minimum;
      this.minimum = details.minimum;
    }
    if (details?.maximum !== undefined) {
      this.max = details.maximum;
      this.maximum = details.maximum;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static missingRequired(name: string): RuntimeConfigError {
    return new RuntimeConfigError('MissingRequired', { name });
  }

  static missingAllowedChannels(): RuntimeConfigError {
    return new RuntimeConfigError('MissingAllowedChannels');
  }

  static invalidInteger(name: string): RuntimeConfigError {
    return new RuntimeConfigError('InvalidInteger', { name });
  }

  static invalidDurationSeconds(name: string): RuntimeConfigError {
    return new RuntimeConfigError('InvalidDurationSeconds', { name });
  }

  static durationSecondsOutOfRange(
    name: string,
    minimum: bigint,
    maximum: bigint
  ): RuntimeConfigError {
    return new RuntimeConfigError('DurationSecondsOutOfRange', { name, minimum, maximum });
  }
}

export interface RuntimeConfig {
  readonly botToken: SecretString;
  readonly remoteMcp: RemoteMcpConfig | null;
  readonly allowedChannelIds: Set<bigint>;
  readonly allowedUserIds: Set<bigint>;
  readonly plainAskMentionUserIds: Set<bigint>;
  readonly startupChannelId: bigint | null;
  readonly guildId: bigint | null;
  readonly allowAllChannels: boolean;
  readonly enableMessageContent: boolean;
  readonly qaCommands: boolean;
  readonly hostCommands: boolean;
  readonly streamCommentary: boolean;
  readonly startupNotify: boolean;
  readonly sessionMirror: boolean;
  readonly attachmentsEnabled: boolean;
  readonly attachmentMaxBytes: bigint;
  readonly attachmentTextInlineMaxBytes: bigint;
  readonly historyPollIntervalNs: bigint | null;
  readonly appServerResumeTimeoutNs: bigint;
  readonly appServerHistoryReadTimeoutNs: bigint;
}

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);
const I128_MIN = -170141183460469231731687303715884105728n;
const I128_MAX = 170141183460469231731687303715884105727n;

function flag(env: ReadonlyMap<string, string>, name: string, defaultValue: boolean): boolean {
  const raw = env.get(name);
  if (raw === undefined) return defaultValue;
  const trimmed = rustTrim(raw);
  if (trimmed === '') return defaultValue;
  return !FALSE_VALUES.has(asciiLower(trimmed));
}

function required(env: ReadonlyMap<string, string>, name: string): string {
  const raw = env.get(name);
  if (raw === undefined) {
    throw RuntimeConfigError.missingRequired(name);
  }
  const trimmed = rustTrim(raw);
  if (trimmed === '') {
    throw RuntimeConfigError.missingRequired(name);
  }
  return trimmed;
}

function intSet(env: ReadonlyMap<string, string>, name: string): Set<bigint> {
  const raw = env.get(name);
  if (raw === undefined) return new Set();
  const parts = raw.split(',');
  const nums: bigint[] = [];
  for (const part of parts) {
    const trimmed = rustTrim(part);
    const parsed = parseRustU64(trimmed);
    if (parsed !== null) {
      nums.push(parsed);
    }
  }
  nums.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return new Set(nums);
}

function optionalInteger(env: ReadonlyMap<string, string>, name: string): bigint | null {
  const raw = env.get(name);
  if (raw === undefined) return null;
  const trimmed = rustTrim(raw);
  if (trimmed === '') return null;
  const parsed = parseRustU64(trimmed);
  if (parsed === null) {
    throw RuntimeConfigError.invalidInteger(name);
  }
  return parsed;
}

function soleValue(values: Set<bigint>): bigint | null {
  if (values.size === 1) {
    return values.values().next().value ?? null;
  }
  return null;
}

function parseRustI128(raw: string): bigint | null {
  if (!/^[+-]?[0-9]+$/.test(raw)) return null;
  try {
    const val = BigInt(raw);
    if (val >= I128_MIN && val <= I128_MAX) {
      return val;
    }
    return null;
  } catch {
    return null;
  }
}

function boundedInteger(
  env: ReadonlyMap<string, string>,
  name: string,
  defaultValue: bigint,
  minimum: bigint,
  maximum: bigint
): bigint {
  const raw = env.get(name);
  if (raw === undefined) return defaultValue;
  const trimmed = rustTrim(raw);
  const parsed = parseRustI128(trimmed);
  if (parsed === null) return defaultValue;
  let clamped = parsed;
  if (clamped < minimum) clamped = minimum;
  if (clamped > maximum) clamped = maximum;
  return clamped;
}

export function secondsToNanos(seconds: number): bigint {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0n;
  }
  const buf = new ArrayBuffer(8);
  new Float64Array(buf)[0] = seconds;
  const bits = new BigUint64Array(buf)[0]!;
  const expBits = (bits >> 52n) & 0x7ffn;
  const mantissaBits = bits & 0xfffffffffffffn;

  let num: bigint;
  let den: bigint;
  if (expBits === 0n) {
    num = mantissaBits;
    den = 1n << 1074n;
  } else {
    const exp = expBits - 1023n - 52n;
    const m = (1n << 52n) | mantissaBits;
    if (exp >= 0n) {
      num = m << exp;
      den = 1n;
    } else {
      num = m;
      den = 1n << -exp;
    }
  }

  const N = num * 1_000_000_000n;
  const q = N / den;
  const r = N % den;
  const r2 = r * 2n;
  if (r2 < den) return q;
  if (r2 > den) return q + 1n;
  return (q & 1n) === 0n ? q : q + 1n;
}

function optionalBoundedDuration(
  env: ReadonlyMap<string, string>,
  name: string,
  defaultSeconds: number,
  maximumSeconds: number
): bigint | null {
  const raw = env.get(name);
  let seconds: number;
  if (raw === undefined) {
    seconds = defaultSeconds;
  } else {
    const trimmed = rustTrim(raw);
    if (trimmed === '') {
      seconds = defaultSeconds;
    } else if (/^[+-]?(?:nan|inf|infinity)$/i.test(trimmed)) {
      seconds = defaultSeconds;
    } else if (/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(trimmed)) {
      const parsed = Number(trimmed);
      seconds = Number.isFinite(parsed) ? parsed : defaultSeconds;
    } else {
      seconds = defaultSeconds;
    }
  }
  if (seconds < 0) seconds = 0;
  if (seconds > maximumSeconds) seconds = maximumSeconds;
  if (seconds <= 0) return null;
  const nanos = secondsToNanos(seconds);
  return nanos > 1n ? nanos : 1n;
}

function strictBoundedDurationSeconds(
  env: ReadonlyMap<string, string>,
  name: string,
  defaultSeconds: bigint,
  minimumSeconds: bigint,
  maximumSeconds: bigint
): bigint {
  const raw = env.get(name);
  if (raw === undefined) return defaultSeconds * 1_000_000_000n;
  const trimmed = rustTrim(raw);
  if (trimmed === '') return defaultSeconds * 1_000_000_000n;
  const seconds = parseRustU64(trimmed);
  if (seconds === null) {
    throw RuntimeConfigError.invalidDurationSeconds(name);
  }
  if (seconds < minimumSeconds || seconds > maximumSeconds) {
    throw RuntimeConfigError.durationSecondsOutOfRange(name, minimumSeconds, maximumSeconds);
  }
  return seconds * 1_000_000_000n;
}

function trimChar(s: string, char: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === char) {
    start++;
  }
  while (end > start && s[end - 1] === char) {
    end--;
  }
  return s.slice(start, end);
}

export function mergeEnvText(env: Map<string, string>, text: string): void {
  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rustTrim(rawLine);
    if (line === '' || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = rustTrim(line.slice(0, eqIdx));
    if (key === '' || env.has(key)) continue;
    let val = rustTrim(line.slice(eqIdx + 1));
    val = trimChar(val, '"');
    val = trimChar(val, "'");
    env.set(key, val);
  }
}

export function loadRuntimeConfig(
  env: ReadonlyMap<string, string>,
  cli: CliOptions = defaultCliOptions()
): RuntimeConfig {
  const botToken = required(env, 'DISCORD_BOT_TOKEN');
  const allowedChannelIds = intSet(env, 'DISCORD_ALLOWED_CHANNEL_IDS');
  const allowAllChannels = flag(env, 'DISCORD_ALLOW_ALL_CHANNELS', false);
  if (allowedChannelIds.size === 0 && !allowAllChannels) {
    throw RuntimeConfigError.missingAllowedChannels();
  }
  const startupChannelId =
    optionalInteger(env, 'DISCORD_STARTUP_CHANNEL_ID') ?? soleValue(allowedChannelIds);
  const envMessageContent = flag(env, 'DISCORD_ENABLE_MESSAGE_CONTENT', true);
  const remoteMcp = loadRemoteMcpConfig(env);
  const allowedUserIds = intSet(env, 'DISCORD_ALLOWED_USER_IDS');
  const plainAskMentionUserIds = intSet(env, 'DISCORD_PLAIN_ASK_MENTION_USER_IDS');
  const guildId = optionalInteger(env, 'DISCORD_GUILD_ID');
  const qaCommands = flag(env, 'DISCORD_ENABLE_QA_COMMANDS', false);
  const hostCommands = flag(env, 'DISCORD_ENABLE_HOST_COMMANDS', false);
  const streamCommentary = flag(env, 'DISCORD_STREAM_COMMENTARY', true);
  const startupNotify = flag(env, 'DISCORD_STARTUP_NOTIFY', false);
  const sessionMirror = flag(env, 'DISCORD_SESSION_MIRROR', true);
  const attachmentsEnabled = flag(env, 'DISCORD_ENABLE_ATTACHMENTS', true);
  const attachmentMaxBytes = boundedInteger(
    env,
    'DISCORD_ATTACHMENT_MAX_BYTES',
    26214400n,
    1n,
    104857600n
  );
  const attachmentTextInlineMaxBytes = boundedInteger(
    env,
    'DISCORD_ATTACHMENT_TEXT_INLINE_MAX_BYTES',
    32768n,
    0n,
    1048576n
  );
  const historyPollIntervalNs = optionalBoundedDuration(
    env,
    'DISCORD_HISTORY_POLL_SECONDS',
    15.0,
    300.0
  );
  const appServerResumeTimeoutNs = strictBoundedDurationSeconds(
    env,
    'DISCORD_APP_SERVER_RESUME_TIMEOUT_SECONDS',
    60n,
    10n,
    300n
  );
  const appServerHistoryReadTimeoutNs = strictBoundedDurationSeconds(
    env,
    'DISCORD_APP_SERVER_HISTORY_READ_TIMEOUT_SECONDS',
    60n,
    10n,
    300n
  );

  return {
    botToken: new SecretString(botToken),
    remoteMcp,
    allowedChannelIds,
    allowedUserIds,
    plainAskMentionUserIds,
    startupChannelId,
    guildId,
    allowAllChannels,
    enableMessageContent: envMessageContent && !cli.noMessageContent,
    qaCommands,
    hostCommands,
    streamCommentary,
    startupNotify,
    sessionMirror,
    attachmentsEnabled,
    attachmentMaxBytes,
    attachmentTextInlineMaxBytes,
    historyPollIntervalNs,
    appServerResumeTimeoutNs,
    appServerHistoryReadTimeoutNs,
  };
}
