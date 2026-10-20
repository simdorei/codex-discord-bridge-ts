import {types} from 'node:util';
import {invokeSynchronousVoid} from '../../core/synchronous-void.ts';
/** Capacity-one wake retained across queue recovery and completion startup. It
 * carries no work or authority; durable discovery remains the source of jobs.
 * Exactly one pipeline may bind. Close only after that pipeline has joined. */
export class RuntimeDeliveryWake{
 #pending=false;#used=false;#closed=false;#handler:(()=>void)|null=null;
 constructor(){if(new.target!==RuntimeDeliveryWake)throw new TypeError('Expected exact delivery wake owner');Object.freeze(this);}
 assertAvailable():void{if(this.#closed||this.#used)throw new TypeError('Delivery wake already bound or closed');}
 notify():void{if(this.#closed)return;this.#pending=true;this.#flush();}
 #flush():void{if(!this.#pending||this.#handler===null)return;this.#pending=false;try{invokeSynchronousVoid(this.#handler,{},[]);}catch(error){this.#pending=true;throw error;}}
 bind(handler:()=>void):void{
  if(typeof handler!=='function'||types.isProxy(handler)||types.isAsyncFunction(handler)||types.isGeneratorFunction(handler))throw new TypeError('Expected synchronous delivery wake');
  this.assertAvailable();this.#used=true;this.#handler=handler;this.#flush();
 }
 close():void{this.#closed=true;this.#handler=null;this.#pending=false;}
}
Object.freeze(RuntimeDeliveryWake.prototype);
