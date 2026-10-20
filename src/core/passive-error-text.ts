import {types} from 'node:util';
/** Read only an own data message. Never invoke unknown getters, proxy traps,
 * toString, cause or stack. The caller owns the fallback and any token redaction. */
export function passiveErrorText(error: unknown, fallback: string): string {
  if (error !== null && typeof error === 'object' && !types.isProxy(error)) {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string') return descriptor.value;
  }
  return fallback;
}
