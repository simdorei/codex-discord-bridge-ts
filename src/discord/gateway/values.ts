import {types} from 'node:util';
/** Gateway contracts accept owned data, never execute input accessors/coercions. */
export function gatewayOwnField(input:unknown,key:string):unknown{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected gateway data record');
 const field=Object.getOwnPropertyDescriptor(input,key);if(field===undefined||!Object.hasOwn(field,'value'))throw new TypeError('Expected own gateway data field');return field.value;
}
export function gatewayId(value:unknown):bigint{if(typeof value!=='bigint'||value<=0n||value>=(1n<<64n))throw new TypeError('Expected gateway nonzero u64 identity');return value;}
/** Enforce the already-decoded DTO contract without getters, proxies, functions,
 * mutable descendants, cycles or opaque class instances. BigInt is permitted because
 * typed timestamps contain nanoseconds outside Serde's ordinary integer interval. */
export function gatewayImmutableData(input:unknown):void{
 const seen=new WeakSet<object>(),active=new WeakSet<object>();
 const visit=(value:unknown,depth:number):void=>{
  if(value===null||typeof value==='boolean'||typeof value==='bigint')return;
  if(typeof value==='string'){if(/[\uD800-\uDFFF]/u.test(value))throw new TypeError('Invalid gateway text');return;}
  if(typeof value==='number'){if(!Number.isFinite(value))throw new TypeError('Invalid gateway number');return;}
  if(typeof value!=='object'||types.isProxy(value)||!Object.isFrozen(value))throw new TypeError('Expected deeply immutable gateway data');
  if(depth>=128||active.has(value))throw new TypeError('Invalid gateway data nesting');if(seen.has(value))return;
  const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==Array.prototype&&prototype!==null)throw new TypeError('Opaque gateway data object');
  if(Object.getOwnPropertySymbols(value).length!==0)throw new TypeError('Symbol gateway data field');active.add(value);seen.add(value);
  if(Array.isArray(value)){for(let i=0;i<value.length;i++)if(!Object.hasOwn(value,String(i)))throw new TypeError('Sparse gateway data vector');}
  for(const key of Object.getOwnPropertyNames(value)){if(Array.isArray(value)&&key==='length')continue;const field=Object.getOwnPropertyDescriptor(value,key)!;if(!Object.hasOwn(field,'value'))throw new TypeError('Active gateway data field');visit(field.value,depth+1);}
  active.delete(value);
 };visit(input,0);
}
