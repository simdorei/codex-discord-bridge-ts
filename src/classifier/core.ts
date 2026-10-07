/**
 * Central Error Pure Classification Core Module.
 *
 * Implements hostile pre-inspection barrier, immediate prototype equivalence
 * pin lookup, accessor-safe own primitive descriptor validation, and opaque fallback.
 *
 * Intrinsic Assumption:
 * Assumes standard Node.js V8 runtime intrinsics (node:util.types.isProxy,
 * Object.getPrototypeOf, Object.getOwnPropertyDescriptor, Object.hasOwn,
 * Object.entries, Object.defineProperty, Object.freeze) operate untampered.
 *
 * Purity Invariants:
 * - Diagnostic metadata only; never nominal brand proof, capability token, or authority grant.
 * - Zero mutation of candidate errors, error prototypes, or caller context.
 * - Zero accessor execution, zero string coercion, zero stack parsing, zero cause walking.
 * - Immediate prototype equivalence only (strict === equality, zero prototype chain traversal).
 */

import { types } from 'node:util';
import type { ClassificationResult, DiagnosticContext } from './schema.ts';
import { findRegistryPin } from './registry.ts';

/**
 * Creates an unknown classification result preserving the raw error identity
 * and caller diagnostic context references unmodified.
 */
function createUnknownResult<C extends DiagnosticContext>(
  raw: unknown,
  context: C,
): ClassificationResult<C> {
  return {
    classification: {
      status: 'unknown',
    },
    raw,
    context,
  };
}

/**
 * Evaluates candidate error against the static registry with hostile trap denial.
 *
 * Pure functional classification:
 * 1. Primitive/null early exit.
 * 2. Hostile proxy pre-inspection rejection before property or prototype read.
 * 3. Immediate prototype equivalence lookup (zero prototype traversal).
 * 4. Accessor-safe own primitive data descriptor extraction and kind/literal validation.
 * 5. Returns passive diagnostic classification result without mutating inputs.
 */
export function classifyError<C extends DiagnosticContext>(
  error: unknown,
  context: C,
): ClassificationResult<C> {
  // Step 1: Primitive / Null Early Exit
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return createUnknownResult(error, context);
  }

  // Step 2: Hostile Proxy Barrier (evaluated before any property read, prototype inspection, or descriptor read)
  if (types.isProxy(error)) {
    return createUnknownResult(error, context);
  }

  // Step 3: Immediate Prototype Match (Zero Traversal)
  const proto: unknown = Object.getPrototypeOf(error);
  if (proto === null || (typeof proto !== 'object' && typeof proto !== 'function')) {
    return createUnknownResult(error, context);
  }

  const pin = findRegistryPin(proto as object);
  if (pin === undefined) {
    return createUnknownResult(error, context);
  }

  // Step 4: Accessor-Safe Own Primitive Descriptor Extraction
  const extracted: Record<string, string | bigint | null> = Object.create(null);

  for (const [fieldName, validator] of Object.entries(pin.fields)) {
    if (typeof validator !== 'object' || validator === null) {
      continue;
    }

    const desc = Object.getOwnPropertyDescriptor(error, fieldName);

    // Reject missing, non-own, or accessor descriptors without executing getters/setters
    if (desc === undefined || !Object.hasOwn(desc, 'value')) {
      return createUnknownResult(error, context);
    }

    const val: unknown = desc.value;

    // Validate required primitive kind via own data descriptor to prevent inherited getter execution
    const kindDesc = Object.getOwnPropertyDescriptor(validator, 'kind');
    if (kindDesc === undefined || !Object.hasOwn(kindDesc, 'value')) {
      return createUnknownResult(error, context);
    }

    const kind = kindDesc.value;

    switch (kind) {
      case 'string':
        if (typeof val !== 'string') {
          return createUnknownResult(error, context);
        }
        break;
      case 'bigint':
        if (typeof val !== 'bigint') {
          return createUnknownResult(error, context);
        }
        break;
      case 'string_or_null':
        if (typeof val !== 'string' && val !== null) {
          return createUnknownResult(error, context);
        }
        break;
      default:
        return createUnknownResult(error, context);
    }

    // Validate closed literal enum only if specified as an own data descriptor
    const literalsDesc = Object.getOwnPropertyDescriptor(validator, 'allowedLiterals');
    if (literalsDesc !== undefined) {
      if (!Object.hasOwn(literalsDesc, 'value')) {
        return createUnknownResult(error, context);
      }
      const allowedLiterals = literalsDesc.value;
      if (allowedLiterals !== undefined) {
        if (!Array.isArray(allowedLiterals) || typeof val !== 'string' || !allowedLiterals.includes(val)) {
          return createUnknownResult(error, context);
        }
      }
    }

    // Define own data property on null-prototype container using a null-prototype descriptor
    const propDesc: PropertyDescriptor = Object.create(null);
    propDesc.value = val as string | bigint | null;
    propDesc.writable = false;
    propDesc.enumerable = true;
    propDesc.configurable = false;

    Object.defineProperty(extracted, fieldName, propDesc);
  }

  // Step 5: Emit Classified Result
  return {
    classification: {
      status: 'classified',
      matchKey: pin.key,
      fields: Object.freeze(extracted),
    },
    raw: error,
    context,
  };
}
