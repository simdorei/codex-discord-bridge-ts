import {createHash} from "node:crypto";
import {requireDiscordText} from "./text.ts";
const MAX_U64=(1n<<64n)-1n,MAX_NONCE=(1n<<63n)-1n;
function u64(value:bigint):Buffer{const b=Buffer.alloc(8);b.writeBigUInt64BE(value);return b;}
/** Stable logical-chunk nonce. Server deduplication is time-limited, not permanent exactly-once delivery. */
export function messageNonce(domain:string,channelId:bigint,logicalKey:string,chunkIndex:bigint|number):bigint{
  requireDiscordText(domain);requireDiscordText(logicalKey);
  if(typeof channelId!=="bigint"||channelId<=0n||channelId>MAX_U64)throw new RangeError("Expected nonzero u64 Discord channel");
  if(typeof chunkIndex==="number"&&(!Number.isSafeInteger(chunkIndex)||chunkIndex<0))throw new RangeError("Expected lossless chunk index");
  if(typeof chunkIndex!=="number"&&typeof chunkIndex!=="bigint")throw new TypeError("Expected chunk index");
  const index=BigInt(chunkIndex);if(index<0n||index>MAX_U64)throw new RangeError("Expected u64 chunk index");
  const hash=createHash("sha256").update("cdr-discord/idempotent-message/v1");
  const prefix=(value:string):void=>{const bytes=Buffer.from(value,"utf8");hash.update(u64(BigInt(bytes.length)));hash.update(bytes);};
  prefix(domain);hash.update(u64(channelId));prefix(logicalKey);hash.update(u64(index));return hash.digest().readBigUInt64BE(0)&MAX_NONCE;
}
