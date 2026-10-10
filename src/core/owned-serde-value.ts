import {boundedSerdeByteCount} from "./serde-byte-count.ts";
function freeze(value:unknown):void{if(value===null||typeof value!=="object")return;for(const name of Object.getOwnPropertyNames(value)){const d=Object.getOwnPropertyDescriptor(value,name)!;if(Object.hasOwn(d,"value"))freeze(d.value);}Object.freeze(value);}
/** Copy decoded JSON without numeric reserialization; reject accessors/proxies before clone.
 * Count validation is not a process heap budget. Returned object graphs are immutable. */
export function cloneOwnedSerdeValue(value:unknown):unknown{
  if(boundedSerdeByteCount(value,Number.MAX_SAFE_INTEGER)===null)throw new TypeError("Expected decoded Serde Value");
  const owned=structuredClone(value);freeze(owned);return owned;
}
