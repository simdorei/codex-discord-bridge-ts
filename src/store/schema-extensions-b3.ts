import type { DatabaseSync } from "node:sqlite";

const OPERATIONS = ["INSERT", "UPDATE"] as const;

const ARCHIVE_GUARDED: readonly (readonly [string, string])[] = [
  [
    "codex_goal_progress",
    "target_thread_id=NEW.thread OR NEW.channel IN (SELECT value FROM json_each(channels))",
  ],
  [
    "codex_commentary_outbox",
    "target_thread_id=NEW.target_thread_id OR NEW.channel_id IN (SELECT value FROM json_each(channels))",
  ],
  [
    "codex_turn_queue",
    "target_thread_id=NEW.target_thread_id OR NEW.channel_id IN (SELECT value FROM json_each(channels))",
  ],
  [
    "codex_prompt_intakes",
    "target_thread_id=NEW.target_thread_id OR NEW.channel_id IN (SELECT value FROM json_each(channels))",
  ],
  [
    "codex_delivery_outbox",
    "target_thread_id=NEW.target_thread_id OR NEW.channel_id IN (SELECT value FROM json_each(channels))",
  ],
  [
    "busy_choices",
    "target_thread_id=NEW.target_thread_id OR NEW.channel_id IN (SELECT value FROM json_each(channels))",
  ],
  [
    "mirror_threads",
    "target_thread_id=NEW.codex_thread_id OR NEW.discord_thread_id IN (SELECT value FROM json_each(channels))",
  ],
];

const ARCHIVE_INGRESS_TRIGGERS: readonly string[] = [
  "cdr_archive_ingress_save",
  "cdr_archive_ingress_execute",
  "cdr_archive_receipt",
];

const CLEANUP_GUARDED: readonly (readonly [string, string])[] = [
  [
    "codex_goal_progress",
    "channel_id=NEW.channel OR (phase='deleting' AND target_thread_id=NEW.thread)",
  ],
  [
    "codex_commentary_outbox",
    "channel_id=NEW.channel_id OR (phase='deleting' AND target_thread_id=NEW.target_thread_id)",
  ],
  [
    "codex_turn_queue",
    "channel_id=NEW.channel_id OR (phase='deleting' AND target_thread_id=NEW.target_thread_id)",
  ],
  [
    "codex_prompt_intakes",
    "channel_id=NEW.channel_id OR (phase='deleting' AND target_thread_id=NEW.target_thread_id)",
  ],
  [
    "codex_delivery_outbox",
    "channel_id=NEW.channel_id OR (phase='deleting' AND target_thread_id=NEW.target_thread_id)",
  ],
  [
    "busy_choices",
    "channel_id=NEW.channel_id OR (phase='deleting' AND target_thread_id=NEW.target_thread_id)",
  ],
  [
    "mirror_threads",
    "channel_id=NEW.discord_thread_id OR channel_id=NEW.discord_channel_id OR (phase='deleting' AND target_thread_id=NEW.codex_thread_id)",
  ],
  ["mirror_projects", "channel_id=NEW.discord_channel_id"],
];

const CLEANUP_INGRESS_TRIGGERS: readonly string[] = [
  "cdr_cleanup_ingress_save",
  "cdr_cleanup_ingress_execute",
  "cdr_cleanup_receipt",
];

function queryExists(
  db: DatabaseSync,
  sql: string,
  ...params: readonly (string | number)[]
): boolean {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  if (!row) {
    return false;
  }
  const value = Object.values(row)[0];
  return value === 1 || value === 1n;
}

function hasTrigger(db: DatabaseSync, name: string): boolean {
  return queryExists(
    db,
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name=?)",
    name,
  );
}

function migrateArchiveSchema(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS cdr_archive_fences(target_thread_id TEXT PRIMARY KEY, token TEXT NOT NULL, channels TEXT NOT NULL CHECK(json_valid(channels)),phase TEXT NOT NULL CHECK(phase IN ('deleting','deleted')),created_at REAL NOT NULL);",
  );
  for (const [table, predicate] of ARCHIVE_GUARDED) {
    for (const operation of OPERATIONS) {
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS cdr_archive_${table}_${operation} BEFORE ${operation} ON ${table} WHEN EXISTS(SELECT 1 FROM cdr_archive_fences WHERE ${predicate}) BEGIN SELECT RAISE(ABORT,'archive deletion fenced; operation not executed'); END;`,
      );
    }
  }
  db.exec(
    "CREATE TRIGGER IF NOT EXISTS cdr_archive_ingress_save AFTER INSERT ON discord_ingress_journal WHEN EXISTS(SELECT 1 FROM cdr_archive_fences WHERE target_thread_id=NEW.target_thread_id OR NEW.channel_id IN (SELECT value FROM json_each(channels))) BEGIN UPDATE discord_ingress_journal SET state='held',phase='archive_fenced',hold_reason='archive deletion in progress or completed; original request saved without execution' WHERE ingress_id=NEW.ingress_id; END;\n    CREATE TRIGGER IF NOT EXISTS cdr_archive_ingress_execute BEFORE UPDATE ON discord_ingress_journal WHEN NEW.state IN ('staged','acknowledged','executing','owned') AND EXISTS(SELECT 1 FROM cdr_archive_fences WHERE target_thread_id=NEW.target_thread_id OR NEW.channel_id IN (SELECT value FROM json_each(channels))) BEGIN SELECT RAISE(ABORT,'archive deletion fenced; ingress cannot execute'); END;\n    CREATE TRIGGER IF NOT EXISTS cdr_archive_receipt BEFORE INSERT ON codex_delivery_receipts WHEN EXISTS(SELECT 1 FROM cdr_archive_fences WHERE CASE WHEN json_valid(NEW.receipt_key) THEN CASE WHEN json_type(NEW.receipt_key,'$[0]')='integer' THEN json_extract(NEW.receipt_key,'$[0]') IN (SELECT value FROM json_each(channels)) ELSE 1 END ELSE 1 END) BEGIN SELECT RAISE(ABORT,'archive deletion fenced; delivery not attempted'); END;",
  );
}

function schemaCurrentArchive(db: DatabaseSync): boolean {
  if (
    !queryExists(
      db,
      "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='cdr_archive_fences')",
    )
  ) {
    return false;
  }
  for (const [table] of ARCHIVE_GUARDED) {
    for (const operation of OPERATIONS) {
      if (!hasTrigger(db, `cdr_archive_${table}_${operation}`)) {
        return false;
      }
    }
  }
  for (const name of ARCHIVE_INGRESS_TRIGGERS) {
    if (!hasTrigger(db, name)) {
      return false;
    }
  }
  return true;
}

function migrateArchivedEvidence(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS cdr_archived_cleanup_evidence (\n         token TEXT NOT NULL, channel_id INTEGER NOT NULL, target_thread_id TEXT NOT NULL,\n         ingress_id TEXT NOT NULL, payload_json TEXT NOT NULL, outcome_json TEXT NOT NULL,\n         row_snapshot_json TEXT NOT NULL, archive_json TEXT NOT NULL, created_at REAL NOT NULL,\n         PRIMARY KEY(token,ingress_id));\n         CREATE INDEX IF NOT EXISTS cdr_archived_cleanup_evidence_ingress\n         ON cdr_archived_cleanup_evidence(ingress_id);\n         CREATE TRIGGER IF NOT EXISTS cdr_archived_cleanup_evidence_no_update\n         BEFORE UPDATE ON cdr_archived_cleanup_evidence\n         BEGIN SELECT RAISE(ABORT,'archived cleanup evidence is append-only'); END;\n         CREATE TRIGGER IF NOT EXISTS cdr_archived_cleanup_evidence_no_delete\n         BEFORE DELETE ON cdr_archived_cleanup_evidence\n         BEGIN SELECT RAISE(ABORT,'archived cleanup evidence is append-only'); END;",
  );
}

function schemaCurrentArchivedEvidence(db: DatabaseSync): boolean {
  const exists = queryExists(
    db,
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='cdr_archived_cleanup_evidence')",
  );
  const indexed = queryExists(
    db,
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='index' AND name='cdr_archived_cleanup_evidence_ingress')",
  );
  return (
    exists &&
    indexed &&
    hasTrigger(db, "cdr_archived_cleanup_evidence_no_update") &&
    hasTrigger(db, "cdr_archived_cleanup_evidence_no_delete")
  );
}

export function migrateRoomCleanup(db: DatabaseSync): void {
  migrateArchiveSchema(db);
  migrateArchivedEvidence(db);
  db.exec(
    "CREATE TABLE IF NOT EXISTS cdr_cleanup_fences (channel_id INTEGER PRIMARY KEY CHECK(channel_id>0),target_thread_id TEXT,token TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('deleting','deleted')),created_at REAL NOT NULL);",
  );
  for (const [table, predicate] of CLEANUP_GUARDED) {
    for (const operation of OPERATIONS) {
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS cdr_cleanup_${table}_${operation} BEFORE ${operation} ON ${table} WHEN EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE ${predicate}) BEGIN SELECT RAISE(ABORT,'room cleanup fence active; operation not executed'); END;`,
      );
    }
  }
  db.exec(
    "CREATE TRIGGER IF NOT EXISTS cdr_cleanup_ingress_save AFTER INSERT ON discord_ingress_journal WHEN EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE channel_id=NEW.channel_id OR (phase='deleting' AND target_thread_id=NEW.target_thread_id)) BEGIN UPDATE discord_ingress_journal SET state='held',phase='cleanup_fenced',hold_reason='room cleanup in progress or completed; original request saved without execution' WHERE ingress_id=NEW.ingress_id; END;\n    CREATE TRIGGER IF NOT EXISTS cdr_cleanup_ingress_execute BEFORE UPDATE ON discord_ingress_journal WHEN NEW.state IN ('staged','acknowledged','executing','owned') AND EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE channel_id=NEW.channel_id OR (phase='deleting' AND target_thread_id=NEW.target_thread_id)) BEGIN SELECT RAISE(ABORT,'room cleanup fence active; ingress cannot execute'); END;\n    CREATE TRIGGER IF NOT EXISTS cdr_cleanup_receipt BEFORE INSERT ON codex_delivery_receipts WHEN EXISTS(SELECT 1 FROM cdr_cleanup_fences WHERE CASE WHEN json_valid(NEW.receipt_key) THEN CASE WHEN json_type(NEW.receipt_key,'$[0]')='integer' THEN channel_id=json_extract(NEW.receipt_key,'$[0]') ELSE 1 END ELSE 1 END) BEGIN SELECT RAISE(ABORT,'room cleanup fence active; delivery not attempted'); END;",
  );
}

export function schemaCurrentRoomCleanup(db: DatabaseSync): boolean {
  if (!schemaCurrentArchive(db) || !schemaCurrentArchivedEvidence(db)) {
    return false;
  }
  const exists = queryExists(
    db,
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='cdr_cleanup_fences')",
  );
  if (!exists) {
    return false;
  }
  for (const [table] of CLEANUP_GUARDED) {
    for (const operation of OPERATIONS) {
      if (!hasTrigger(db, `cdr_cleanup_${table}_${operation}`)) {
        return false;
      }
    }
  }
  for (const name of CLEANUP_INGRESS_TRIGGERS) {
    if (!hasTrigger(db, name)) {
      return false;
    }
  }
  return true;
}
