/** Acceptance grammar of uuid 1.26.0 Uuid::parse_str. No normalization: callers
 * retain the original identifier spelling, including case and wrapper. */
export function isRustUuidText(value:unknown):value is string {
 if(typeof value!=='string')return false;
 if(value.length===32)return /^[0-9a-fA-F]{32}$/u.test(value);
 let body=value;
 if(value.length===38&&value[0]==='{'&&value[37]==='}')body=value.slice(1,-1);
 else if(value.length===45&&value.startsWith('urn:uuid:'))body=value.slice(9);
 return body.length===36&&/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(body);
}
