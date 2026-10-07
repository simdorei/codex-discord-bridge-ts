import { parseSerdeValue } from "./serde-json-parse.ts";

/** Required-field Serde structs only: no flatten/default/Option/custom visitors. */
export type StructField = "string" | "i64" | "bool" | "value" | StructShape;
export interface StructShape { readonly fields: readonly (readonly [string, StructField])[] }

// JSON.parse checks grammar first. This scanner only finds raw value boundaries;
// ignored fields must not acquire Value's number, Unicode or recursion semantics.
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") i += 2;
    else if (text[i++] === '"') return i;
  }
  throw new SyntaxError("Unterminated JSON string");
}
function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] !== "{" && text[start] !== "[") {
    let i = start;
    while (i < text.length && !/[\s,}\]]/.test(text[i]!)) i++;
    return i;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '"') { i = stringEnd(text, i) - 1; continue; }
    if (text[i] === "{" || text[i] === "[") depth++;
    if (text[i] === "}" || text[i] === "]") { if (--depth === 0) return i + 1; }
  }
  throw new SyntaxError("Unterminated JSON container");
}
function whitespace(text: string, start: number): number {
  while (/[\x20\t\n\r]/.test(text[start] ?? "x")) start++;
  return start;
}
function decodeField(raw: string, kind: StructField, depth: number): unknown {
  if (typeof kind !== "string") return decodeStruct(raw, kind, depth);
  // Parent typed structs consume the same recursion budget as Value containers.
  let value: unknown = parseSerdeValue("[".repeat(depth) + raw + "]".repeat(depth));
  for (let i = 0; i < depth; i++) value = (value as unknown[])[0];
  if (kind === "value") return value;
  if (kind === "string" && typeof value === "string") return value;
  if (kind === "bool" && typeof value === "boolean") return value;
  if (kind === "i64" && typeof value === "bigint" && value >= -(1n << 63n) && value < (1n << 63n)) return value;
  throw new SyntaxError(`Expected Serde ${kind}`);
}
function decodeStruct(raw: string, shape: StructShape, depth: number): Record<string, unknown> {
  if (++depth >= 128) throw new SyntaxError("Serde recursion limit exceeded");
  const text = raw.trim();
  if (text[0] !== "{" && text[0] !== "[") throw new SyntaxError("Expected Serde struct map or sequence");
  const map = text[0] === "{";
  const result: Record<string, unknown> = Object.create(null);
  const fields = new Map(shape.fields);
  let i = whitespace(text, 1), position = 0;
  while (text[i] !== (map ? "}" : "]")) {
    let key: string;
    if (map) {
      const end = stringEnd(text, i);
      key = parseSerdeValue<string>(text.slice(i, end));
      i = whitespace(text, whitespace(text, end) + 1); // colon, grammar already checked
    } else {
      const field = shape.fields[position++];
      if (!field) throw new SyntaxError("Excess Serde struct sequence field");
      key = field[0];
    }
    const end = valueEnd(text, i), kind = fields.get(key);
    if (kind !== undefined) {
      if (Object.hasOwn(result, key)) throw new SyntaxError(`Duplicate Serde field: ${key}`);
      result[key] = decodeField(text.slice(i, end), kind, depth);
    }
    i = whitespace(text, end);
    if (text[i] === ",") i = whitespace(text, i + 1);
  }
  for (const [key] of shape.fields) {
    if (!Object.hasOwn(result, key)) throw new SyntaxError(`Missing Serde field: ${key}`);
  }
  return result;
}

/** Shape is trusted code, never input. Returned records have no prototype. */
export function parseSerdeStruct(text: string, shape: StructShape): Record<string, unknown> {
  if (typeof text !== "string" || /[\uD800-\uDFFF]/u.test(text)) throw new SyntaxError("Expected well-formed JSON text");
  JSON.parse(text); // lexical validity; ignored values deliberately remain untyped
  return decodeStruct(text, shape, 0);
}
