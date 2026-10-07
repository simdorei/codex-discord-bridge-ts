import type { DatabaseSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';

export const MAX_CATALOGS = 64;
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

const CATALOG_SIGNATURE_QUERY = `SELECT json_group_array(json_array(user_version,type,name,tbl_name,sql)) AS signature
         FROM (SELECT v.user_version,s.type,s.name,s.tbl_name,s.sql
         FROM pragma_user_version AS v LEFT JOIN main.sqlite_schema AS s ON 1
         ORDER BY s.type,s.name)`;

export function getCatalogSignature(db: DatabaseSync): string {
  const stmt = db.prepare(CATALOG_SIGNATURE_QUERY);
  const row = stmt.get() as { signature?: unknown } | undefined;
  if (!row || typeof row.signature !== 'string') {
    throw new Error('Failed to retrieve catalog signature');
  }
  return row.signature;
}

export class CatalogCache {
  readonly #entries: string[] = [];
  #bytes = 0;

  contains(signature: string): boolean {
    return this.#entries.includes(signature);
  }

  remember(signature: string): void {
    const size = Buffer.byteLength(signature, 'utf8');
    if (size > MAX_CATALOG_BYTES || this.#entries.includes(signature)) {
      return;
    }

    while (
      this.#entries.length >= MAX_CATALOGS ||
      this.#bytes + size > MAX_CATALOG_BYTES
    ) {
      const old = this.#entries.shift();
      if (old === undefined) {
        return;
      }
      this.#bytes -= Buffer.byteLength(old, 'utf8');
    }

    this.#bytes += size;
    this.#entries.push(signature);
  }

  get size(): number {
    return this.#entries.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get snapshot(): readonly string[] {
    return [...this.#entries];
  }
}
