import {types} from 'node:util';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';

export type RemoteSocketFrame={readonly type:'text';readonly text:string}|{readonly type:'ping';readonly payload:Uint8Array}|{readonly type:'binary'|'pong'|'frame'|'close'};
export class RemoteFrameError extends Error {
 readonly kind:'UnsupportedBinary'|'ClosedBeforeHello';
 constructor(kind:RemoteFrameError['kind']){super(kind==='UnsupportedBinary'?'the gateway sent an unsupported binary message':'the gateway closed before acknowledging the bridge hello');this.name='RemoteFrameError';this.kind=kind;}
}
const typedArrayBytes=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength')!.get!;
/** One borrowed receive owner. Returning raw text intentionally separates frame
 * readiness from native JSON decoding: the connection loop can select one event
 * before starting its shared native lane, avoiding eager Promise decoder races.
 * No actual socket or session is created. Ports must settle their accepted I/O. */
export class RemoteTextReader {
 readonly #receive:(signal?:AbortSignal)=>Promise<RemoteSocketFrame|null>;
 readonly #pong:(payload:Uint8Array,signal?:AbortSignal)=>Promise<void>;
 readonly #maxBytes:number;
 #busy=false;
 constructor(receive:(signal?:AbortSignal)=>Promise<RemoteSocketFrame|null>,pong:(payload:Uint8Array,signal?:AbortSignal)=>Promise<void>,maxBytes=12000000){
  for(const fn of [receive,pong])if(typeof fn!=='function'||types.isProxy(fn)||types.isGeneratorFunction(fn))throw new TypeError('Expected owned remote frame port');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid remote frame byte budget');
  this.#receive=receive;this.#pong=pong;this.#maxBytes=maxBytes;
 }
 async receiveText(waitingForHello:boolean,signal?:AbortSignal):Promise<string|null>{
  signal?.throwIfAborted();if(typeof waitingForHello!=='boolean')throw new TypeError('Expected hello state');
  if(this.#busy)throw new Error('A remote frame receive is already pending');this.#busy=true;
  try{
   let ignored=0;
   for(;;){
    signal?.throwIfAborted();const pending=this.#receive(signal);if(!types.isPromise(pending))throw new TypeError('Remote receive must return a Promise');
    const frame=await pending;signal?.throwIfAborted();if(frame===null)return null;
    const kind=own(frame,'type');
    switch(kind){
     case 'text':{
      const text=own(frame,'text');if(typeof text!=='string')throw new TypeError('Expected remote text frame');
      if(text.length>this.#maxBytes||Buffer.byteLength(text)>this.#maxBytes)throw new RangeError('Remote text frame exceeds byte budget');return text;
     }
     case 'binary':throw new RemoteFrameError('UnsupportedBinary');
     case 'close':if(waitingForHello)throw new RemoteFrameError('ClosedBeforeHello');return null;
     case 'ping':{
      const payload=own(frame,'payload');if(types.isProxy(payload)||!types.isUint8Array(payload))throw new TypeError('Expected owned ping bytes');
      const size=Reflect.apply(typedArrayBytes,payload,[]) as number;if(size>125)throw new RangeError('Remote control frame exceeds 125 bytes');
      const copy=new Uint8Array(size);for(let i=0;i<size;i++)copy[i]=payload[i]!;
      const sent=this.#pong(copy,signal);if(!types.isPromise(sent))throw new TypeError('Remote pong must return a Promise');await sent;signal?.throwIfAborted();break;
     }
     case 'pong':case 'frame':break;
     default:throw new TypeError('Unknown remote frame type');
    }
    // Explicit cooperative scheduling for immediately resolved control frames.
    if(++ignored===64){try{await yieldTurn(undefined,{signal});}catch(error){signal?.throwIfAborted();throw error;}ignored=0;}
   }
  }finally{this.#busy=false;}
 }
}
Object.freeze(RemoteTextReader.prototype);
