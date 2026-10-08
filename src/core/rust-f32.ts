/** Direct Rust i64/u64 -> IEEE binary32 conversion. Going through Number first
 * can double-round integers near binary32 midpoints above 2^53. */
export function rustIntegerToF32(value:bigint):number {
 if(typeof value!=='bigint'||value<-(1n<<63n)||value>=(1n<<64n))throw new TypeError('Expected Rust i64/u64 integer');
 const negative=value<0n,absolute=negative?-value:value,bits=absolute.toString(2).length;
 if(bits<=24)return Number(value);
 const shift=BigInt(bits-24),half=1n<<(shift-1n);let mantissa=absolute>>shift;const remainder=absolute-(mantissa<<shift);
 if(remainder>half||remainder===half&&(mantissa&1n)!==0n)mantissa++;
 const result=Number(mantissa)*2**Number(shift);return negative?-result:result;
}
