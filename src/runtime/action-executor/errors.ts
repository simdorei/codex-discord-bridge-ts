/** Shared command boundary errors; adapters preserve raw underlying store/transport errors. */
export class InvalidActionRequestError extends Error{readonly kind="InvalidActionRequest";constructor(reason:string){super(`invalid command request: ${reason}`);this.name="InvalidActionRequestError";}}
export class MissingActionAppServerError extends Error{readonly kind="MissingAppServer";constructor(){super("resident Codex app-server is unavailable for this command");this.name="MissingActionAppServerError";}}
export class NoActionTargetError extends Error{readonly kind="NoTarget";constructor(){super("no Codex thread target is selected or mirrored for this channel");this.name="NoActionTargetError";}}
export class ActionIntegerRangeError extends Error{readonly kind="IntegerRange";constructor(){super("Discord identifier does not fit the SQLite integer contract");this.name="ActionIntegerRangeError";}}
