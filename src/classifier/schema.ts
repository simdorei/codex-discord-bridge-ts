/**
 * Caller-supplied diagnostic context. Validated as a caller precondition.
 * Preserved identically by reference without error inspection or modification.
 */
export interface DiagnosticContext {
  readonly [key: string]: unknown;
}

/**
 * Supported primitive field kinds for safe, accessor-free own-descriptor extraction.
 */
export type BoundedFieldKind = 'string' | 'bigint' | 'string_or_null';

/**
 * Field validator specification requiring primitive kind matching plus an optional closed enum of exact string literals.
 */
export interface BoundedFieldValidator {
  readonly kind: BoundedFieldKind;
  readonly allowedLiterals?: readonly string[];
}

export type BoundedFieldMap = Readonly<Record<string, BoundedFieldValidator>>;

/**
 * Closed set of 14 exact registry keys, preserving both distinct InvalidQueueStateError identities.
 */
export type RegistryKey =
  | 'Admission.DrainGateError'
  | 'Restart.InvalidThreadStateError'
  | 'Restart.InvalidClassifierArgumentError'
  | 'Store.StoreIntegrityError'
  | 'Store.UnsupportedVersionError'
  | 'Store.QueueJobNotFoundError'
  | 'Store.QueueRead.InvalidQueueStateError'
  | 'Store.QueueAttachGoal.InvalidQueueStateError'
  | 'Store.SystemTimeError'
  | 'Store.MirrorMappingChangedError'
  | 'Store.ForkHandoffUnresolvedError'
  | 'Store.ForkHandoffTargetMovedError'
  | 'Store.ForkHandoffCycleError'
  | 'Store.DeadGenerationTargetHeldError';

export interface ClassifiedMetadata<K extends RegistryKey = RegistryKey> {
  readonly status: 'classified';
  readonly matchKey: K;
  readonly fields: Readonly<Record<string, string | bigint | null>>;
}

export interface UnknownMetadata {
  readonly status: 'unknown';
}

export type ClassificationMetadata = ClassifiedMetadata | UnknownMetadata;

export interface ClassificationResult<C extends DiagnosticContext = DiagnosticContext> {
  readonly classification: ClassificationMetadata;
  /** Exact SAME original error identity reference preserved unmodified. */
  readonly raw: unknown;
  /** Exact SAME validated caller diagnostic context reference preserved unmodified. */
  readonly context: C;
}

export interface RegistryPinRecord {
  readonly key: RegistryKey;
  readonly prototype: object;
  readonly fields: BoundedFieldMap;
}
