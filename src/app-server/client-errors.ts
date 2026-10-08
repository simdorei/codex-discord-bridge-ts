const ownedClientFailures=new WeakMap<object,"Closed"|"InvalidReply">();
export function ownedClientFailure(error:unknown):"Closed"|"InvalidReply"|null{return error!==null&&(typeof error==="object"||typeof error==="function")?ownedClientFailures.get(error)??null:null;}
export class AppServerClosedError extends Error{readonly kind="Closed";constructor(){super("app-server transport is closed");this.name="AppServerClosedError";ownedClientFailures.set(this,"Closed");}}

export class AppServerInvalidReplyError extends Error{readonly kind="InvalidReply";constructor(detail:string){super(`invalid app-server reply: ${detail}`);this.name="AppServerInvalidReplyError";ownedClientFailures.set(this,"InvalidReply");}}
