import {inspect,types} from 'node:util';
import {SecretToken} from '../../config/remote.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {gatewayIntents} from './config.ts';
import {gatewayOwnField} from './values.ts';
import type {GatewayControlCommand} from './session-machine.ts';
export type EncodedGatewayControl={readonly kind:'Text';readonly payload:string;readonly heartbeat:boolean}|{readonly kind:'Close';readonly code:number;readonly reason:string}|{readonly kind:'FlushOnly';readonly heartbeat:boolean};
function text(value:unknown):string{if(typeof value!=='string'||/[\uD800-\uDFFF]/u.test(value))throw new TypeError('Expected well-formed Gateway string');return value;}
function sequence(value:unknown):bigint{if(typeof value!=='bigint'||value<0n||value>=(1n<<64n))throw new TypeError('Expected Gateway u64 sequence');return value;}
/** Source Config::new default Identify profile: Bot prefix, threshold50,
 * compress=false, presence=null and twilight.rs properties. Tokens stay private
 * until explicit wire encoding. Encoding itself performs no network IO. */
export class GatewayControlEncoder{
 readonly #token:string;readonly #shard:readonly [bigint,bigint];readonly #intents:bigint;readonly #os:string;
 constructor(options:{token:SecretToken;shardNumber:number;shardTotal:number;messageContent:boolean;os?:string}){
  if(types.isProxy(options.token))throw new TypeError('Expected owned secret token');const token=text(SecretToken.prototype.expose.call(options.token));this.#token=token.startsWith('Bot ')?token:'Bot '+token;
  const number=options.shardNumber,total=options.shardTotal;if(!Number.isInteger(number)||!Number.isInteger(total)||number<0||number>=total||total>4294967295)throw new TypeError('Invalid Gateway shard');
  this.#shard=Object.freeze([BigInt(number),BigInt(total)]);this.#intents=gatewayIntents(options.messageContent);this.#os=text(options.os??(process.platform==='win32'?'windows':process.platform==='darwin'?'macos':process.platform));Object.freeze(this);
 }
 [inspect.custom]():string{return 'GatewayControlEncoder([REDACTED])';}
 toString():string{return 'GatewayControlEncoder([REDACTED])';}
 toJSON():string{return '[REDACTED]';}
 encode(command:GatewayControlCommand):EncodedGatewayControl{
  const kind=gatewayOwnField(command,'kind');let payload:unknown,heartbeat=false;
  switch(kind){
   case 'Heartbeat':{const value=gatewayOwnField(command,'sequence');payload={d:value===null?null:sequence(value),op:1n};heartbeat=true;break;}
   case 'Identify':payload={d:{compress:false,intents:this.#intents,large_threshold:50n,presence:null,properties:{browser:'twilight.rs',device:'twilight.rs',os:this.#os},shard:this.#shard,token:this.#token},op:2n};break;
   case 'Resume':payload={d:{seq:sequence(gatewayOwnField(command,'sequence')),session_id:text(gatewayOwnField(command,'sessionId')),token:this.#token},op:6n};break;
   case 'Close':{const code=gatewayOwnField(command,'code');if(typeof code!=='number'||!Number.isInteger(code)||code<0||code>65535)throw new TypeError('Expected Gateway u16 close code');return Object.freeze({kind:'Close',code,reason:code===1000?'closing connection':code===4000?'resuming connection':''});}
   case 'FlushOnly':{const value=gatewayOwnField(command,'heartbeat');if(typeof value!=='boolean')throw new TypeError('Expected Gateway flush flag');return Object.freeze({kind:'FlushOnly',heartbeat:value});}
   default:throw new TypeError('Unknown Gateway control command');
  }
  return Object.freeze({kind:'Text',payload:serializeSerdeValue(payload),heartbeat});
 }
}
