/**
 * Static Prototype Pin Table
 *
 * Implements the closed-set prototype table mapping trusted class prototypes
 * to bounded field descriptors.
 *
 * Intrinsic Trust Assumption:
 * Assumes standard Node.js / V8 runtime intrinsics (Object, Map, Object.freeze,
 * Object.values, Object.getPrototypeOf, Object.getOwnPropertyDescriptor, Object.hasOwn,
 * Object.defineProperty) operate untampered.
 *
 * Security & Purity Invariants:
 * - Static prototype mapping is stored in a private, unexported Map constructed once
 *   at module evaluation with no mutation path (set, delete, clear) after construction.
 * - Freezing Map does not seal internal slots; security rests on private unexported closure.
 * - Deep freeze ONLY registry-owned record/field-map/validator/literal-array objects;
 *   never recursively freeze external Error prototypes, error, or caller context.
 * - Every registry-owned validator, field-map, and pin record is constructed with a null
 *   prototype (Object.create(null)), ensuring prototype pollution on Object.prototype
 *   (e.g., Object.prototype.allowedLiterals) cannot poison validator property lookups.
 * - Core Object.defineProperty descriptor arguments are created with null prototypes
 *   and explicit own value/writable/enumerable/configurable properties to prevent
 *   ToPropertyDescriptor from seeing inherited Object.prototype.get/set accessors.
 * - Property extraction from raw definitions uses own data descriptors only via
 *   Object.getOwnPropertyDescriptor and Object.hasOwn(desc, "value"), never reading
 *   inherited properties or invoking accessors.
 * - Reference visibility is not authority; classification outputs are diagnostic metadata.
 */

import type {
  BoundedFieldKind,
  BoundedFieldMap,
  BoundedFieldValidator,
  RegistryKey,
  RegistryPinRecord,
} from './schema.ts';

import { DrainGateError } from '../admission/owned-key.ts';
import {
  InvalidClassifierArgumentError,
  InvalidThreadStateError,
} from '../restart/thread-state.ts';
import { ForkHandoffCycleError } from '../store/fork-canonical-target.ts';
import { DeadGenerationTargetHeldError } from '../store/fork-completed-target.ts';
import {
  ForkHandoffTargetMovedError,
  ForkHandoffUnresolvedError,
} from '../store/fork-handoff-admission.ts';
import {
  InvalidQueueStateError as QueueAttachGoalInvalidQueueStateError,
  SystemTimeError,
} from '../store/queue-attach-goal.ts';
import { MirrorMappingChangedError } from '../store/queue-enqueue.ts';
import {
  InvalidQueueStateError as QueueReadInvalidQueueStateError,
  QueueJobNotFoundError,
} from '../store/queue-read.ts';
import {
  StoreIntegrityError,
  UnsupportedVersionError,
} from '../store/schema-assembly.ts';

/**
 * Creates a null-prototype property descriptor with explicit own data attributes.
 * Prevents ToPropertyDescriptor from traversing Object.prototype to inspect get/set.
 */
function createDataDescriptor<T>(value: T): PropertyDescriptor {
  const desc = Object.create(null);
  desc.value = value;
  desc.writable = false;
  desc.enumerable = true;
  desc.configurable = false;
  return desc;
}

/**
 * Safely extracts an own data property value from an object without reading accessors
 * or traversing prototype chains.
 */
function getOwnDataValue<T>(obj: unknown, prop: string): T | undefined {
  if (typeof obj !== 'object' || obj === null) {
    return undefined;
  }
  const desc = Object.getOwnPropertyDescriptor(obj, prop);
  if (desc !== undefined && Object.hasOwn(desc, 'value')) {
    return desc.value as T;
  }
  return undefined;
}

/**
 * Creates a null-prototype validator with explicit own data properties.
 * If allowedLiterals is omitted, the property does not exist on the object,
 * and since prototype is null, no inherited property or accessor can ever be read.
 */
function createValidator(
  kind: BoundedFieldKind,
  allowedLiterals?: readonly string[],
): BoundedFieldValidator {
  const validator = Object.create(null) as {
    kind: BoundedFieldKind;
    allowedLiterals?: readonly string[];
  };

  Object.defineProperty(validator, 'kind', createDataDescriptor(kind));

  if (allowedLiterals !== undefined) {
    Object.defineProperty(
      validator,
      'allowedLiterals',
      createDataDescriptor(Object.freeze([...allowedLiterals])),
    );
  }

  return Object.freeze(validator);
}

/**
 * Deeply freezes and converts registry-owned record, field map, validator, and literal arrays
 * into null-prototype objects with safe own data properties.
 * Intentionally does NOT freeze external Error prototypes (record.prototype).
 */
function deepFreezePinRecord(record: RegistryPinRecord): RegistryPinRecord {
  const fields = Object.create(null) as Record<string, BoundedFieldValidator>;

  const rawFields = getOwnDataValue<BoundedFieldMap>(record, 'fields') ?? record.fields;

  for (const [fieldName, rawValidator] of Object.entries(rawFields)) {
    if (typeof rawValidator !== 'object' || rawValidator === null) {
      continue;
    }

    const kind = getOwnDataValue<BoundedFieldKind>(rawValidator, 'kind');
    if (kind === undefined) {
      continue;
    }

    const rawLiterals = getOwnDataValue<readonly string[]>(rawValidator, 'allowedLiterals');
    const allowedLiterals = Array.isArray(rawLiterals)
      ? Object.freeze([...rawLiterals])
      : undefined;

    const validator = createValidator(kind, allowedLiterals);
    Object.defineProperty(fields, fieldName, createDataDescriptor(validator));
  }

  const frozenFields = Object.freeze(fields) as BoundedFieldMap;

  const key = getOwnDataValue<RegistryKey>(record, 'key') ?? record.key;
  const proto = getOwnDataValue<object>(record, 'prototype') ?? record.prototype;

  const safeRecord = Object.create(null) as {
    key: RegistryKey;
    prototype: object;
    fields: BoundedFieldMap;
  };

  Object.defineProperty(safeRecord, 'key', createDataDescriptor(key));
  Object.defineProperty(safeRecord, 'prototype', createDataDescriptor(proto));
  Object.defineProperty(safeRecord, 'fields', createDataDescriptor(frozenFields));

  return Object.freeze(safeRecord) as RegistryPinRecord;
}

const PIN_ENTRIES: readonly RegistryPinRecord[] = Object.freeze([
  deepFreezePinRecord({
    key: 'Admission.DrainGateError',
    prototype: DrainGateError.prototype,
    fields: {
      kind: {
        kind: 'string',
        allowedLiterals: [
          'InvalidKey',
          'Sealed',
          'FenceMismatch',
          'LockPoisoned',
          'DisposedHandle',
        ],
      },
    },
  }),
  deepFreezePinRecord({
    key: 'Restart.InvalidThreadStateError',
    prototype: InvalidThreadStateError.prototype,
    fields: {
      threadId: { kind: 'string' },
      thread_id: { kind: 'string' },
      reason: { kind: 'string' },
    },
  }),
  deepFreezePinRecord({
    key: 'Restart.InvalidClassifierArgumentError',
    prototype: InvalidClassifierArgumentError.prototype,
    fields: {
      argument: { kind: 'string' },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.StoreIntegrityError',
    prototype: StoreIntegrityError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['Integrity'] },
      result: { kind: 'string' },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.UnsupportedVersionError',
    prototype: UnsupportedVersionError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['UnsupportedVersion'] },
      found: { kind: 'bigint' },
      supported: { kind: 'bigint' },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.QueueJobNotFoundError',
    prototype: QueueJobNotFoundError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['QueueJobNotFound'] },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.QueueRead.InvalidQueueStateError',
    prototype: QueueReadInvalidQueueStateError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['InvalidQueueState'] },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.QueueAttachGoal.InvalidQueueStateError',
    prototype: QueueAttachGoalInvalidQueueStateError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['InvalidQueueState'] },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.SystemTimeError',
    prototype: SystemTimeError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['SystemTime'] },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.MirrorMappingChangedError',
    prototype: MirrorMappingChangedError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['MirrorMappingChanged'] },
      discordChannelId: { kind: 'bigint' },
      expectedTargetThreadId: { kind: 'string' },
      actualTargetThreadId: { kind: 'string_or_null' },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.ForkHandoffUnresolvedError',
    prototype: ForkHandoffUnresolvedError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['ForkHandoffUnresolved'] },
      targetThreadId: { kind: 'string' },
      lastError: { kind: 'string_or_null' },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.ForkHandoffTargetMovedError',
    prototype: ForkHandoffTargetMovedError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['ForkHandoffTargetMoved'] },
      sourceThreadId: { kind: 'string' },
      targetThreadId: { kind: 'string' },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.ForkHandoffCycleError',
    prototype: ForkHandoffCycleError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['ForkHandoffCycle'] },
      sourceThreadId: { kind: 'string' },
    },
  }),
  deepFreezePinRecord({
    key: 'Store.DeadGenerationTargetHeldError',
    prototype: DeadGenerationTargetHeldError.prototype,
    fields: {
      kind: { kind: 'string', allowedLiterals: ['DeadGenerationTargetHeld'] },
      targetThreadId: { kind: 'string' },
    },
  }),
]);

/**
 * Static private prototype map constructed once at module evaluation.
 * Kept strictly unexported with no mutation methods (set, delete, clear).
 */
const REGISTRY = new Map<object, RegistryPinRecord>();

for (const entry of PIN_ENTRIES) {
  REGISTRY.set(entry.prototype, entry);
}

/**
 * Read-only lookup querying the static prototype pin table.
 *
 * @param prototype Candidate prototype object to find in the registry.
 * @returns The deeply frozen RegistryPinRecord if registered, or undefined otherwise.
 */
export function findRegistryPin(prototype: object): RegistryPinRecord | undefined {
  if (typeof prototype !== 'object' || prototype === null) {
    return undefined;
  }
  return REGISTRY.get(prototype);
}
