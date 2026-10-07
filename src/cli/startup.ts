import path from 'node:path';
import { parseRustU64 } from '../config/remote.ts';

export interface CliOptions {
  noMessageContent: boolean;
  checkConfig: boolean;
}

export interface StartupArgs {
  cli: CliOptions;
  envPath: string | null;
  backupStore: boolean;
  restartReadiness: boolean;
  restartQuietSeconds: bigint;
  restartWaitTimeoutSeconds: bigint;
  help: boolean;
}

export type CliErrorVariant =
  | 'Unknown'
  | 'MissingEnvPath'
  | 'InvalidUtf8'
  | 'MissingValue'
  | 'InvalidSeconds'
  | 'RestartOptionsWithoutReadiness';

export class CliError extends Error {
  override readonly name = 'CliError';
  readonly variant: CliErrorVariant;
  readonly tag: CliErrorVariant;
  readonly kind: CliErrorVariant;
  readonly argument?: string | undefined;
  readonly flagName?: string | undefined;
  readonly value?: string | undefined;

  constructor(variant: 'Unknown', argument: string);
  constructor(variant: 'MissingEnvPath');
  constructor(variant: 'InvalidUtf8');
  constructor(variant: 'MissingValue', flagName: string);
  constructor(variant: 'InvalidSeconds', flagName: string, value: string);
  constructor(variant: 'RestartOptionsWithoutReadiness');
  constructor(variant: CliErrorVariant, argOrFlag?: string, value?: string) {
    let message: string;
    switch (variant) {
      case 'Unknown':
        message = `unknown argument: ${argOrFlag}`;
        break;
      case 'MissingEnvPath':
        message = 'missing path after --env';
        break;
      case 'InvalidUtf8':
        message = 'argument is not valid UTF-8';
        break;
      case 'MissingValue':
        message = `missing value after ${argOrFlag}`;
        break;
      case 'InvalidSeconds':
        message = `invalid non-negative integer after ${argOrFlag}: ${value}`;
        break;
      case 'RestartOptionsWithoutReadiness':
        message = 'restart timing options require --restart-readiness';
        break;
    }
    super(message);
    this.variant = variant;
    this.tag = variant;
    this.kind = variant;
    if (variant === 'Unknown') {
      this.argument = argOrFlag;
    } else if (variant === 'MissingValue') {
      this.flagName = argOrFlag;
      this.argument = argOrFlag;
    } else if (variant === 'InvalidSeconds') {
      this.flagName = argOrFlag;
      this.argument = argOrFlag;
      this.value = value;
    }
  }

  static unknown(arg: string): CliError {
    return new CliError('Unknown', arg);
  }

  static missingEnvPath(): CliError {
    return new CliError('MissingEnvPath');
  }

  static invalidUtf8(): CliError {
    return new CliError('InvalidUtf8');
  }

  static missingValue(name: string): CliError {
    return new CliError('MissingValue', name);
  }

  static invalidSeconds(name: string, value: string): CliError {
    return new CliError('InvalidSeconds', name, value);
  }

  static restartOptionsWithoutReadiness(): CliError {
    return new CliError('RestartOptionsWithoutReadiness');
  }
}

function isWellFormedUnicode(value: string): boolean {
  return (value as unknown as {isWellFormed():boolean}).isWellFormed();
}

function parseSeconds(raw: string, name: string): bigint {
  const value = parseRustU64(raw);
  if (value === null) {
    throw CliError.invalidSeconds(name, raw);
  }
  return value;
}

export function parseStartupArgs(args: readonly string[]): StartupArgs {
  const parsed: StartupArgs = {
    cli: {
      noMessageContent: false,
      checkConfig: false,
    },
    envPath: null,
    backupStore: false,
    restartReadiness: false,
    restartQuietSeconds: 90n,
    restartWaitTimeoutSeconds: 900n,
    help: false,
  };

  let hasRestartTiming = false;
  let i = 0;

  while (i < args.length) {
    const raw = args[i++]!;
    if (!isWellFormedUnicode(raw)) {
      throw CliError.invalidUtf8();
    }

    switch (raw) {
      case '--no-message-content':
        parsed.cli.noMessageContent = true;
        break;
      case '--check-config':
        parsed.cli.checkConfig = true;
        break;
      case '--backup-store':
        parsed.backupStore = true;
        break;
      case '--restart-readiness':
        parsed.restartReadiness = true;
        break;
      case '--restart-quiet-seconds': {
        hasRestartTiming = true;
        if (i >= args.length) {
          throw CliError.missingValue('--restart-quiet-seconds');
        }
        const valRaw = args[i++]!;
        if (!isWellFormedUnicode(valRaw)) {
          throw CliError.invalidUtf8();
        }
        parsed.restartQuietSeconds = parseSeconds(valRaw, '--restart-quiet-seconds');
        break;
      }
      case '--restart-wait-timeout-seconds': {
        hasRestartTiming = true;
        if (i >= args.length) {
          throw CliError.missingValue('--restart-wait-timeout-seconds');
        }
        const valRaw = args[i++]!;
        if (!isWellFormedUnicode(valRaw)) {
          throw CliError.invalidUtf8();
        }
        parsed.restartWaitTimeoutSeconds = parseSeconds(valRaw, '--restart-wait-timeout-seconds');
        break;
      }
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--env': {
        if (i >= args.length) {
          throw CliError.missingEnvPath();
        }
        parsed.envPath = args[i++]!;
        break;
      }
      default:
        throw CliError.unknown(raw);
    }
  }

  if (hasRestartTiming && !parsed.restartReadiness) {
    throw CliError.restartOptionsWithoutReadiness();
  }

  return parsed;
}

export type StartupPlanKind =
  | 'admin'
  | 'help'
  | 'restartReadiness'
  | 'checkConfig'
  | 'backupStore'
  | 'gateway';

export interface StartupPlan {
  readonly kind: StartupPlanKind;
  readonly args: StartupArgs | null;
  readonly adminArgs?: readonly string[] | undefined;
  readonly requiresEnvironment: boolean;
  readonly requiresConfig: boolean;
}

export function planStartup(argv: readonly string[]): StartupPlan {
  if (argv.length > 0 && argv[0] === '--admin') {
    return {
      kind: 'admin',
      args: null,
      adminArgs: argv.slice(1),
      requiresEnvironment: false,
      requiresConfig: false,
    };
  }

  const args = parseStartupArgs(argv);

  if (args.help) {
    return {
      kind: 'help',
      args,
      requiresEnvironment: false,
      requiresConfig: false,
    };
  }

  if (args.restartReadiness) {
    return {
      kind: 'restartReadiness',
      args,
      requiresEnvironment: true,
      requiresConfig: false,
    };
  }

  if (args.cli.checkConfig) {
    return {
      kind: 'checkConfig',
      args,
      requiresEnvironment: true,
      requiresConfig: true,
    };
  }

  if (args.backupStore) {
    return {
      kind: 'backupStore',
      args,
      requiresEnvironment: true,
      requiresConfig: true,
    };
  }

  return {
    kind: 'gateway',
    args,
    requiresEnvironment: true,
    requiresConfig: true,
  };
}

export interface ConfigSummaryInput {
  readonly guildId: bigint | null;
  readonly allowedChannelIds: ReadonlySet<bigint>;
  readonly allowedUserIds: ReadonlySet<bigint>;
  readonly enableMessageContent: boolean;
  readonly qaCommands: boolean;
}

function formatBigintSet(set: ReadonlySet<bigint>): string {
  const sorted = Array.from(set).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${sorted.map((id) => id.toString()).join(', ')}}`;
}

export function configSummary(config: ConfigSummaryInput): string {
  const guildStr = config.guildId !== null && config.guildId !== undefined ? config.guildId.toString() : '-';
  const channelsStr = formatBigintSet(config.allowedChannelIds);
  const usersStr = formatBigintSet(config.allowedUserIds);
  const msgContent = config.enableMessageContent ? 'true' : 'false';
  const qaCmds = config.qaCommands ? 'true' : 'false';
  return `config_valid token=[REDACTED] guild=${guildStr} channels=${channelsStr} users=${usersStr} message_content=${msgContent} qa_commands=${qaCmds}`;
}

export function helpText(): string {
  return 'Codex Discord Remote TypeScript runtime\n\nOptions:\n  --no-message-content               Use slash commands only\n  --check-config                     Validate configuration without connecting\n  --backup-store                     Create and verify an online cutover DB snapshot\n  --restart-readiness                Wait for fail-closed TypeScript restart readiness\n  --restart-quiet-seconds N          Required idle age for restart (default: 90)\n  --restart-wait-timeout-seconds N   Maximum quiet wait (default: 900)\n  --env PATH                         Load a specific environment file\n  -h, --help                         Show this help';
}

export function defaultEnvPath(executablePath: string): string {
  if (path.win32.parse(executablePath).base === '') {
    return '.env';
  }
  const dir = path.win32.dirname(executablePath);
  return path.win32.join(dir, '.env');
}
