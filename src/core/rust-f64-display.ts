/** Finite f64 Display, default precision: shortest round-trip fixed decimal.
 * Exact binary midpoint intervals use ties-to-even for decimal -> binary; among
 * equally close shortest decimal candidates Rust's Dragon fallback chooses up
 * (away from zero), unlike JS Number.toString's even-last-digit tie rule.
 * No Rust executable differential is implied. This is not precision/debug/exp fmt.
 * Authority: rust 1.97.1 core fmt/float.rs and num/imp/flt2dec/strategy/dragon.rs. */
interface Ratio{n:bigint;d:bigint}
const pow10=(n:number)=>10n**BigInt(n);
function binary(bits:bigint):Ratio{if(bits===0n)return {n:0n,d:1n};if(bits===0x7ff0000000000000n)return {n:1n<<1024n,d:1n};const exponent=Number(bits>>52n),fraction=bits&((1n<<52n)-1n),mantissa=exponent===0?fraction:(1n<<52n)|fraction,power=(exponent===0?-1022:exponent-1023)-52;return power>=0?{n:mantissa<<BigInt(power),d:1n}:{n:mantissa,d:1n<<BigInt(-power)};}
function midpoint(a:Ratio,b:Ratio):Ratio{return {n:a.n*b.d+b.n*a.d,d:2n*a.d*b.d};}
const compare=(a:Ratio,b:Ratio):bigint=>a.n*b.d-b.n*a.d;
function decimal(coefficient:bigint,power:number):Ratio{return power>=0?{n:coefficient*pow10(power),d:1n}:{n:coefficient,d:pow10(-power)};}
function fixed(coefficient:bigint,power:number):string{const digits=coefficient.toString();if(power>=0)return digits+'0'.repeat(power);const position=digits.length+power;return position>0?digits.slice(0,position)+'.'+digits.slice(position):'0.'+'0'.repeat(-position)+digits;}
export function formatRustF64Display(value:number):string{
 if(typeof value!=='number'||!Number.isFinite(value))throw new TypeError('Expected finite f64');if(value===0)return Object.is(value,-0)?'-0':'0';
 const negative=value<0,absolute=Math.abs(value),storage=new DataView(new ArrayBuffer(8));storage.setFloat64(0,absolute);const bits=storage.getBigUint64(0),exact=binary(bits),low=midpoint(binary(bits-1n),exact),high=midpoint(exact,binary(bits+1n)),inclusive=(bits&1n)===0n;
 const estimate=Math.floor(Math.log10(absolute));
 for(let digits=1;digits<=17;digits++){
  let best:{coefficient:bigint;power:number;distance:Ratio;number:Ratio}|undefined;
  for(let power=estimate-digits;power<=estimate-digits+2;power++){
   const scaled=power>=0?{n:exact.n,d:exact.d*pow10(power)}:{n:exact.n*pow10(-power),d:exact.d},floor=scaled.n/scaled.d;
   for(const trial of [floor,floor+1n]){
    if(trial===0n)continue;let coefficient=trial,p=power;while(coefficient%10n===0n){coefficient/=10n;p++;}if(coefficient.toString().length>digits)continue;
    const number=decimal(coefficient,p),lower=compare(number,low),upper=compare(number,high);if(lower<0n||upper>0n||!inclusive&&(lower===0n||upper===0n))continue;
    const delta=compare(number,exact),distance={n:delta<0n?-delta:delta,d:number.d*exact.d};
    if(best===undefined||compare(distance,best.distance)<0n||compare(distance,best.distance)===0n&&compare(number,best.number)>0n)best={coefficient,power:p,distance,number};
   }
  }
  if(best!==undefined)return (negative?'-':'')+fixed(best.coefficient,best.power);
 }
 throw new Error('Finite f64 has no shortest decimal within 17 digits');
}
