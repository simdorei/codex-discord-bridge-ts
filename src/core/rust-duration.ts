const SECOND=1000000000n,MAX=((1n<<64n)*SECOND)-1n;
/** Rust Duration::try_from_secs_f64, represented as nanoseconds. IEEE bits are
 * scaled exactly before ties-to-even rounding; multiplying by 1e9 as Number
 * would introduce an extra rounding step. */
export function rustDurationFromSecondsF64(seconds:number):bigint {
 if(typeof seconds!=='number'||!Number.isFinite(seconds)||seconds<0||seconds>=2**64)throw new RangeError('Float seconds outside Rust Duration');
 const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,seconds);const bits=view.getBigUint64(0),exponent=Number((bits>>52n)&2047n),fraction=bits&((1n<<52n)-1n);
 const mantissa=exponent===0?fraction:fraction+(1n<<52n),power=exponent===0?-1074:exponent-1023-52,numerator=mantissa*SECOND;
 let result:bigint;
 if(power>=0)result=numerator<<BigInt(power);
 else{const shift=BigInt(-power),half=1n<<(shift-1n);result=numerator>>shift;const remainder=numerator-(result<<shift);if(remainder>half||remainder===half&&(result&1n)!==0n)result++;}
 if(result>MAX)throw new RangeError('Rounded duration overflow');return result;
}
export function rustDurationMulF64(nanoseconds:bigint,factor:number):bigint {
 if(typeof nanoseconds!=='bigint'||nanoseconds<0n||nanoseconds>MAX||typeof factor!=='number')throw new TypeError('Expected Rust Duration and f64 factor');
 const seconds=Number(nanoseconds/SECOND)+Number(nanoseconds%SECOND)/1e9;
 return rustDurationFromSecondsF64(factor*seconds);
}
