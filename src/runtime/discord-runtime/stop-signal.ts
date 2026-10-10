let current:RuntimeStopSignal|null=null;
const TOKEN=Symbol('RuntimeStopSignal');
/** Own exactly one SIGINT listener. Other process listeners remain untouched.
 * The signal requests cooperative runtime shutdown; it is never proof of task
 * termination. Dispose only after control/watch operations have joined. Node
 * signal delivery on Windows still requires native console integration QA. */
export class RuntimeStopSignal {
 readonly #controller=new AbortController();readonly #reason=Object.freeze(new Error('Runtime interrupt requested'));readonly #listener=()=>this.#controller.abort(this.#reason);#disposed=false;
 private constructor(token:symbol){if(token!==TOKEN)throw new TypeError('Use RuntimeStopSignal.install');}
 static install():RuntimeStopSignal {
  if(current!==null)throw new Error('Runtime interrupt listener already owned');
  const owner=new RuntimeStopSignal(TOKEN);process.on('SIGINT',owner.#listener);current=owner;Object.freeze(owner);return owner;
 }
 get signal():AbortSignal{return this.#controller.signal;}
 dispose():void{if(this.#disposed)return;process.removeListener('SIGINT',this.#listener);this.#disposed=true;if(current===this)current=null;}
}
