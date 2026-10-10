import * as crypto from "node:crypto";
import type * as fs from "node:fs";
import { open as fsOpen, mkdir, stat, unlink } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

import {
  LATEST_STORE_SCHEMA_VERSION,
  StoreIntegrityError,
  UnsupportedVersionError,
  assertStoreIntegrity,
  migrateSchemaExtensions,
  migrateSchemaVersion,
  schemaExtensionsCurrent,
  schemaVersion,
} from "./schema-assembly.ts";
import {
  CatalogCache,
  getCatalogSignature,
} from "./catalog-cache.ts";

const BACKUP_DIRECTORY = ".codex-discord-backups";

export class ActiveTransactionError extends Error {
  readonly kind = "ActiveTransaction" as const;

  constructor() {
    super(
      "store schema migration requires a connection without an active transaction",
    );
    this.name = "ActiveTransactionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// Module-private process-global catalog cache constructed inside this module.
// Never exported, injected, or exposed to prevalidated signatures.
const PROCESS_CATALOG_CACHE = new CatalogCache();

function isAutocommit(db: DatabaseSync): boolean {
  return !db.isTransaction;
}

function formatUtcTimestamp(date: Date): string {
  const YYYY = date.getUTCFullYear().toString().padStart(4, "0");
  const MM = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const DD = date.getUTCDate().toString().padStart(2, "0");
  const HH = date.getUTCHours().toString().padStart(2, "0");
  const mm = date.getUTCMinutes().toString().padStart(2, "0");
  const SS = date.getUTCSeconds().toString().padStart(2, "0");
  return `${YYYY}${MM}${DD}T${HH}${mm}${SS}Z`;
}

async function backupBeforeMigration(
  db: DatabaseSync,
  dbPath: string,
  fromVersion: bigint,
): Promise<string | null> {
  let stats: fs.Stats;
  try {
    stats = await stat(dbPath);
  } catch (err: unknown) {
    if (
      err !== null &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
  if (stats.size === 0) {
    return null;
  }

  const parent = dirname(dbPath);
  const directory = join(parent, BACKUP_DIRECTORY);
  await mkdir(directory, { recursive: true });

  const parsed = parse(dbPath);
  const stem = parsed.name || "store";
  const timestamp = formatUtcTimestamp(new Date());
  const unique = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const filename = `${stem}.v${fromVersion}-to-v${LATEST_STORE_SCHEMA_VERSION}.${timestamp}.${unique}.sqlite`;
  const backupPath = resolve(join(directory, filename));

  const handle = await fsOpen(backupPath, "wx");
  try {
    await handle.close();
    await sqliteBackup(db, backupPath);
  } catch (backupError) {
    try {
      await unlink(backupPath);
    } catch (cleanupError: unknown) {
      if (
        cleanupError !== null &&
        typeof cleanupError === "object" &&
        "code" in cleanupError &&
        (cleanupError as { code?: unknown }).code === "ENOENT"
      ) {
        // ENOENT ignored
      } else {
        throw cleanupError;
      }
    }
    throw backupError;
  }

  return backupPath;
}

function rememberVerifiedCatalog(db: DatabaseSync): void {
  db.exec("BEGIN DEFERRED;");
  let signature: string | undefined;
  let valid = false;
  let committed = false;
  try {
    signature = getCatalogSignature(db);
    valid =
      schemaVersion(db) === LATEST_STORE_SCHEMA_VERSION &&
      schemaExtensionsCurrent(db);
    db.exec("COMMIT;");
    committed = true;
  } finally {
    if (!committed) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // ignore rollback error on failure
      }
    }
  }
  if (valid && signature !== undefined) {
    PROCESS_CATALOG_CACHE.remember(signature);
  }
}

/**
 * Migrates a database to the latest schema version if needed.
 *
 * Requires an exclusive borrowed DatabaseSync handle during await.
 */
export async function initialize(
  db: DatabaseSync,
  path: string,
): Promise<string | null> {
  const current = schemaVersion(db);
  if (current > LATEST_STORE_SCHEMA_VERSION) {
    throw new UnsupportedVersionError(current, LATEST_STORE_SCHEMA_VERSION);
  }
  if (current === LATEST_STORE_SCHEMA_VERSION && schemaExtensionsCurrent(db)) {
    return null;
  }
  if (!isAutocommit(db)) {
    throw new ActiveTransactionError();
  }

  const backupPath = await backupBeforeMigration(db, path, current);
  db.exec("BEGIN IMMEDIATE;");
  try {
    for (let v = current + 1n; v <= LATEST_STORE_SCHEMA_VERSION; v++) {
      migrateSchemaVersion(db, v);
    }
    migrateSchemaExtensions(db);
    db.exec(`PRAGMA user_version = ${LATEST_STORE_SCHEMA_VERSION};`);
    assertStoreIntegrity(db);
    db.exec("COMMIT;");
  } catch (err) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // ignore rollback error
    }
    throw err;
  }
  return backupPath;
}

/**
 * Opens a SQLite database at the specified path and initializes it to the
 * latest schema version if needed.
 *
 * NOTE: The caller owns the returned DatabaseSync handle and is responsible for
 * closing it when done (`db.close()`).
 */
export async function openInitialized(path: string): Promise<DatabaseSync> {
  const db = new DatabaseSync(path, {
    timeout: 5000,
    enableForeignKeyConstraints: false,
  });

  try {
    const before = getCatalogSignature(db);
    const cached = PROCESS_CATALOG_CACHE.contains(before);
    if (!cached) {
      await initialize(db, path);
      rememberVerifiedCatalog(db);
    }
    return db;
  } catch (err) {
    try {
      db.close();
    } catch {
      // ignore close failure on error path
    }
    throw err;
  }
}

/**
 * A short-lived, read-only snapshot. No initialization or repair from discovery.
 *
 * NOTE: The caller is responsible for ensuring that `close()` is called if
 * `finish()` is not reached (e.g. in a `finally` block or when abandoning the read),
 * to ensure that the read transaction is rolled back and the underlying database
 * connection is released.
 */
export class CheckedRead {
  readonly #connection: DatabaseSync;
  #uncached: string | null;
  #closed = false;
  #finished = false;

  private constructor(connection: DatabaseSync, uncached: string | null) {
    this.#connection = connection;
    this.#uncached = uncached;
  }

  static open(path: string): CheckedRead {
    const connection = new DatabaseSync(path, {
      readOnly: true,
      timeout: 5000,
      enableForeignKeyConstraints: false,
    });
    let success = false;
    try {
      connection.exec("PRAGMA query_only = true;");
      connection.exec("BEGIN DEFERRED;");
      const signature = getCatalogSignature(connection);
      const cached = PROCESS_CATALOG_CACHE.contains(signature);
      if (!cached) {
        requireCurrentSchema(connection);
      }
      const instance = new CheckedRead(connection, cached ? null : signature);
      success = true;
      return instance;
    } finally {
      if (!success) {
        try {
          connection.exec("ROLLBACK;");
        } catch {
          // ignore rollback error on failure
        }
        try {
          connection.close();
        } catch {
          // ignore close error on failure
        }
      }
    }
  }

  connection(): DatabaseSync {
    if (this.#closed || this.#finished) {
      throw new Error("CheckedRead is closed");
    }
    return this.#connection;
  }

  ensureActive(): void {
    if (this.#closed || this.#finished) {
      throw new StoreIntegrityError(
        "metadata read snapshot ended before publication",
      );
    }
    if (isAutocommit(this.#connection)) {
      throw new StoreIntegrityError(
        "metadata read snapshot ended before publication",
      );
    }
  }

  finish(): void {
    if (this.#closed || this.#finished) {
      throw new Error("CheckedRead is closed");
    }
    let committed = false;
    try {
      this.ensureActive();
      this.#connection.exec("COMMIT;");
      committed = true;
      if (this.#uncached !== null) {
        PROCESS_CATALOG_CACHE.remember(this.#uncached);
        this.#uncached = null;
      }
    } catch (err) {
      if (!committed) {
        try {
          this.#connection.exec("ROLLBACK;");
        } catch {
          // ignore rollback error on failure
        }
      }
      throw err;
    } finally {
      this.#finished = true;
      this.#closed = true;
      try {
        this.#connection.close();
      } catch {
        // preserve commit error or original exception
      }
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      if (!this.#finished) {
        try {
          this.#connection.exec("ROLLBACK;");
        } catch {
          // ignore rollback error during discard
        }
      }
    } finally {
      try {
        this.#connection.close();
      } catch {
        // ignore close error during discard
      }
    }
  }
}

/** Supplemental Rust main ed47c482: verify caller transaction without repair or caching. */
export function verifyCurrentCatalogIn(connection: DatabaseSync): void {
  if (!connection.isTransaction) throw new StoreIntegrityError("catalog check requires an active snapshot");
  const signature = getCatalogSignature(connection);
  if (!PROCESS_CATALOG_CACHE.contains(signature)) requireCurrentSchema(connection);
}
function requireCurrentSchema(connection: DatabaseSync): void {
        const found = schemaVersion(connection);
        if (found !== LATEST_STORE_SCHEMA_VERSION) {
          throw new UnsupportedVersionError(found, LATEST_STORE_SCHEMA_VERSION);
        }
        if (!schemaExtensionsCurrent(connection)) {
          throw new StoreIntegrityError(
            "metadata discovery requires an initialized current schema; no repair attempted",
          );
        }
}
