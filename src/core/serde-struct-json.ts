import { parseSerdeValue } from "./serde-json-parse.ts";

/** Serde structs with explicit defaults, Option<String> and f64; no flatten/custom visitors. */
export type StructField = "string" | "i64" | "u64" | "string[]" | "bool" | "value" | "string?" | "f64" | StructShape | StructFieldDecoder;
export interface StructShape { readonly fields: readonly (readonly [string, StructField])[]; readonly defaults?: Readonly<Record<string, unknown>>; readonly mapDefaults?: Readonly<Record<string, unknown>> }
export interface StructDecodeContext {value():unknown;struct(shape:StructShape):Record<string,unknown>;array(field:StructField):unknown[];decode(field:StructField):unknown;map(visit:(key:string,decode:(field:StructField)=>unknown)=>void):void}
export type StructFieldDecoder=(raw:string,depth:number,context:StructDecodeContext)=>unknown;

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
  if (typeof kind === "function") return kind(raw, depth, Object.freeze({value:()=>decodeField(raw,"value",depth),struct:(shape:StructShape)=>decodeStruct(raw,shape,depth),array:(field:StructField)=>decodeArray(raw,field,depth),decode:(field:StructField)=>decodeField(raw,field,depth),map:(visit:(key:string,decode:(field:StructField)=>unknown)=>void)=>decodeMap(raw,depth,visit)})); // Trusted code; raw JSON was checked by the root.
  if (typeof kind !== "string") return decodeStruct(raw, kind, depth);
  // Parent typed structs consume the same recursion budget as Value containers.
  let value: unknown = parseSerdeValue("[".repeat(depth) + raw + "]".repeat(depth));
  for (let i = 0; i < depth; i++) value = (value as unknown[])[0];
  if (kind === "value") return value;
  if (kind === "string?" && (value === null || typeof value === "string")) return value;
  if (kind === "f64" && (typeof value === "number" || typeof value === "bigint") && Number.isFinite(Number(value))) return Number(value);
  if (kind === "string" && typeof value === "string") return value;
  if (kind === "string[]" && Array.isArray(value) && value.every(item => typeof item === "string")) return value;
  if (kind === "u64" && typeof value === "bigint" && value >= 0n && value < (1n << 64n)) return value;
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
  for (const [key, kind] of shape.fields) {
    if (!Object.hasOwn(result, key)) {
      if (shape.defaults !== undefined && Object.hasOwn(shape.defaults,key)) result[key] = structuredClone(shape.defaults[key]);
      else if (map && shape.mapDefaults !== undefined && Object.hasOwn(shape.mapDefaults,key)) result[key] = structuredClone(shape.mapDefaults[key]);
      else if (map && kind === "string?") result[key] = null;
      else throw new SyntaxError(`Missing Serde field: ${key}`);
    }
  }
  return result;
}

/** Custom map visitors decide which values to decode and which duplicate slots
 * count as occupied. In particular, a nullable slot need not be occupied by null. */
function decodeMap(raw:string,depth:number,visit:(key:string,decode:(field:StructField)=>unknown)=>void):void{
  if(++depth>=128)throw new SyntaxError("Serde recursion limit exceeded");
  const text=raw.trim();if(text[0]!=="{")throw new SyntaxError("Expected Serde map");
  let position=whitespace(text,1);
  while(text[position]!=="}"){
    const keyEnd=stringEnd(text,position),key=parseSerdeValue<string>(text.slice(position,keyEnd));
    position=whitespace(text,whitespace(text,keyEnd)+1);
    const end=valueEnd(text,position),value=text.slice(position,end);
    visit(key,(field)=>decodeField(value,field,depth));
    position=whitespace(text,end);if(text[position]===",")position=whitespace(text,position+1);
  }
}

function decodeArray(raw:string,field:StructField,depth:number):unknown[]{
  if(++depth>=128)throw new SyntaxError("Serde recursion limit exceeded");const text=raw.trim();if(text[0]!=="[")throw new SyntaxError("Expected Serde vector");const result:unknown[]=[];let position=whitespace(text,1);
  while(text[position]!=="]"){const end=valueEnd(text,position);result.push(decodeField(text.slice(position,end),field,depth));position=whitespace(text,end);if(text[position]===",")position=whitespace(text,position+1);}return result;
}
/** Entry point for a trusted typed field schema, sharing recursion and duplicate policy. */
export function parseSerdeField(text:string,field:StructField):unknown{
  if(typeof text!=="string"||/[\uD800-\uDFFF]/u.test(text))throw new SyntaxError("Expected well-formed JSON text");JSON.parse(text);return decodeField(text,field,0);
}

/** Shape is trusted code, never input. Returned records have no prototype. */
export function parseSerdeStruct(text: string, shape: StructShape): Record<string, unknown> {
  if (typeof text !== "string" || /[\uD800-\uDFFF]/u.test(text)) throw new SyntaxError("Expected well-formed JSON text");
  JSON.parse(text); // lexical validity; ignored values deliberately remain untyped
  return decodeStruct(text, shape, 0);
}

/** Vec<derived struct>: retain raw element text so duplicate recognized fields are
 * rejected and ignored fields keep the existing typed-struct semantics. */
export function parseSerdeStructArray(text: string, shape: StructShape): Record<string, unknown>[] {
  if(typeof text!=="string"||/[\uD800-\uDFFF]/u.test(text))throw new SyntaxError("Expected well-formed JSON text");
  const lexical:unknown=JSON.parse(text);if(!Array.isArray(lexical))throw new SyntaxError("Expected Serde struct vector");
  const raw=text.trim(),result:Record<string,unknown>[]=[];let position=whitespace(raw,1);
  while(raw[position]!=="]"){const end=valueEnd(raw,position);result.push(decodeStruct(raw.slice(position,end),shape,1));position=whitespace(raw,end);if(raw[position]===",")position=whitespace(raw,position+1);}
  return result;
}
