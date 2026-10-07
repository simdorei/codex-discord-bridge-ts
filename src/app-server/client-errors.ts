export class AppServerClosedError extends Error{readonly kind="Closed";constructor(){super("app-server transport is closed");this.name="AppServerClosedError";}}
