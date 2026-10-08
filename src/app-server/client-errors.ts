export class AppServerClosedError extends Error{readonly kind="Closed";constructor(){super("app-server transport is closed");this.name="AppServerClosedError";}}

export class AppServerInvalidReplyError extends Error{readonly kind="InvalidReply";constructor(detail:string){super(`invalid app-server reply: ${detail}`);this.name="AppServerInvalidReplyError";}}
