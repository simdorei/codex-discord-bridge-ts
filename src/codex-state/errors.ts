import {types} from 'node:util';
export class CodexStateError extends Error {
  readonly kind: 'StateDatabaseMissing' | 'Sqlite';
  readonly path: string | null;
  constructor(kind: 'StateDatabaseMissing' | 'Sqlite', path: string | null, cause?: unknown) {
    let detail = 'database operation failed';
    if (cause !== null && typeof cause === 'object' && !types.isProxy(cause)) {
      const descriptor = Object.getOwnPropertyDescriptor(cause, 'message');
      if (descriptor !== undefined && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string') detail = descriptor.value;
    }
    super(kind === 'StateDatabaseMissing' ? `Codex state database not found: ${path}` : `Codex state SQLite failed: ${detail}`, {cause});
    this.name = 'CodexStateError'; this.kind = kind; this.path = path;
  }
}
