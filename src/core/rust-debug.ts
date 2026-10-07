import { RUST_DEBUG_ESCAPE_RANGES } from "./rust-debug-ranges.ts";

function needsUnicodeEscape(point: number): boolean {
  let low=0;
  let high=RUST_DEBUG_ESCAPE_RANGES.length;
  while(low<high) {
    const mid=low+Math.floor((high-low)/2);
    const range=RUST_DEBUG_ESCAPE_RANGES[mid]!;
    if(point<range[0]) high=mid;
    else if(point>range[1]) low=mid+1;
    else return true;
  }
  return false;
}

/** Rust 1.97.1 String Debug formatting for valid Unicode strings. */
export function rustDebugString(value: string): string {
  if(typeof value!=="string") throw new TypeError("Expected a string");
  const parts=['"'];
  for(const c of value) {
    const point=c.codePointAt(0)!;
    if(point>=0xd800 && point<=0xdfff) throw new TypeError("Expected a well-formed string");
    switch(c) {
      case "\0": parts.push("\\0"); break;
      case "\t": parts.push("\\t"); break;
      case "\r": parts.push("\\r"); break;
      case "\n": parts.push("\\n"); break;
      case "\\": parts.push("\\\\"); break;
      case '"': parts.push('\\"'); break;
      default: parts.push(needsUnicodeEscape(point) ? "\\u{"+point.toString(16)+"}" : c);
    }
  }
  parts.push('"');
  return parts.join("");
}
