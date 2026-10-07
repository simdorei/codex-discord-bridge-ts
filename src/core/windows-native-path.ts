import { types } from "node:util";

export interface WindowsNativePathInput {
  readonly platform: "windows-utf16";
  readonly units: readonly number[];
}

export function windowsNativePathToStringLossy(input: unknown): string {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Expected non-null plain data object");
  }
  if (types.isProxy(input)) {
    throw new TypeError("Proxy objects are not supported");
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError("Expected plain Object.prototype or null-prototype record");
  }

  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== 2 || !ownKeys.includes("platform") || !ownKeys.includes("units")) {
    throw new TypeError('Expected exactly two own properties: "platform" and "units"');
  }

  const platformDesc = Object.getOwnPropertyDescriptor(input, "platform");
  if (
    platformDesc === undefined ||
    platformDesc.get !== undefined ||
    platformDesc.set !== undefined ||
    !platformDesc.enumerable ||
    !("value" in platformDesc)
  ) {
    throw new TypeError('Expected "platform" to be an own enumerable data property');
  }
  if (platformDesc.value !== "windows-utf16") {
    throw new TypeError('Expected platform to be "windows-utf16"');
  }

  const unitsDesc = Object.getOwnPropertyDescriptor(input, "units");
  if (
    unitsDesc === undefined ||
    unitsDesc.get !== undefined ||
    unitsDesc.set !== undefined ||
    !unitsDesc.enumerable ||
    !("value" in unitsDesc)
  ) {
    throw new TypeError('Expected "units" to be an own enumerable data property');
  }

  const rawUnits = unitsDesc.value;
  if (types.isProxy(rawUnits)) {
    throw new TypeError("Proxy arrays are not supported");
  }
  if (!Array.isArray(rawUnits)) {
    throw new TypeError('Expected "units" to be an Array');
  }
  if (Object.getPrototypeOf(rawUnits) !== Array.prototype) {
    throw new TypeError('Expected "units" to have Array.prototype');
  }

  const lengthDesc = Object.getOwnPropertyDescriptor(rawUnits, "length");
  if (
    lengthDesc === undefined ||
    lengthDesc.get !== undefined ||
    lengthDesc.set !== undefined ||
    lengthDesc.enumerable ||
    lengthDesc.configurable ||
    !("value" in lengthDesc)
  ) {
    throw new TypeError('Expected native length descriptor on units array');
  }

  const len = lengthDesc.value;
  if (typeof len !== "number" || !Number.isInteger(len) || len < 0 || Object.is(len, -0)) {
    throw new TypeError("Expected units length to be non-negative integer");
  }

  const unitOwnKeys = Reflect.ownKeys(rawUnits);
  if (unitOwnKeys.length !== len + 1) {
    throw new TypeError("Expected dense units array without extra properties or holes");
  }

  const snapshot = new Uint16Array(len);
  for (let i = 0; i < len; i++) {
    const desc = Object.getOwnPropertyDescriptor(rawUnits, String(i));
    if (
      desc === undefined ||
      desc.get !== undefined ||
      desc.set !== undefined ||
      !desc.enumerable ||
      !("value" in desc)
    ) {
      throw new TypeError(`Expected own enumerable data property at index ${i}`);
    }
    const val = desc.value;
    if (
      typeof val !== "number" ||
      !Number.isInteger(val) ||
      Object.is(val, -0) ||
      val < 0 ||
      val > 65535
    ) {
      throw new TypeError(`Invalid unit at index ${i}: must be unsigned 16-bit integer`);
    }
    snapshot[i] = val;
  }

  const parts: string[] = [];
  let chunk = "";
  let i = 0;
  while (i < len) {
    const u = snapshot[i]!;
    if (u >= 0xd800 && u <= 0xdbff) {
      if (i + 1 < len) {
        const next = snapshot[i + 1]!;
        if (next >= 0xdc00 && next <= 0xdfff) {
          chunk += String.fromCharCode(u, next);
          i += 2;
        } else {
          chunk += "\uFFFD";
          i += 1;
        }
      } else {
        chunk += "\uFFFD";
        i += 1;
      }
    } else if (u >= 0xdc00 && u <= 0xdfff) {
      chunk += "\uFFFD";
      i += 1;
    } else {
      chunk += String.fromCharCode(u);
      i += 1;
    }
    if (chunk.length >= 1024) {
      parts.push(chunk);
      chunk = "";
    }
  }
  if (chunk.length > 0) {
    parts.push(chunk);
  }

  return parts.join("");
}
