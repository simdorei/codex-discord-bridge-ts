/** Equality for already-decoded serde_json Values; not an inspector for arbitrary JS objects. */
export function serdeValueEqual(a: unknown,b: unknown): boolean {
  if(a===b) return true;
  if(a===null||b===null||typeof a!=="object"||typeof b!=="object") return false;
  if(Array.isArray(a)||Array.isArray(b)) return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>serdeValueEqual(v,b[i]));
  const ak=Object.keys(a),bk=Object.keys(b);
  return ak.length===bk.length&&ak.every(k=>Object.hasOwn(b,k)&&serdeValueEqual((a as Record<string,unknown>)[k],(b as Record<string,unknown>)[k]));
}
