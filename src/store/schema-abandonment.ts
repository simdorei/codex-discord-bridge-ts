import type { DatabaseSync } from 'node:sqlite';

const COMPONENT = 'recovery_abandonment';
const FORMAT_VERSION = 1n;

export class AbandonmentIntegrityError extends Error {
  readonly kind = 'Integrity' as const;
  readonly reason: string;

  constructor(reason: string) {
    const prefix = 'SQLite integrity check failed: recovery abandonment storage held: ';
    const message = reason.startsWith(prefix) ? reason : `${prefix}${reason}`;
    super(message);
    this.name = 'AbandonmentIntegrityError';
    this.reason = reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS cdr_recovery_abandonment_proposals (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=32 AND id NOT GLOB '*[^0-9a-f]*'),
    format_version INTEGER NOT NULL CHECK(format_version=1),
    revision INTEGER NOT NULL CHECK(revision>0),
    job_id TEXT NOT NULL,
    target_thread_id TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL CHECK(owner_user_id>0),
    channel_id INTEGER NOT NULL CHECK(channel_id>0),
    application_id INTEGER NOT NULL CHECK(application_id>0),
    seal_json TEXT NOT NULL CHECK(json_valid(seal_json) AND length(CAST(seal_json AS BLOB))<=524288),
    seal_sha256 TEXT NOT NULL CHECK(length(seal_sha256)=64 AND seal_sha256 NOT GLOB '*[^0-9a-f]*'),
    UNIQUE(job_id,revision)
);

-- object --

CREATE TABLE IF NOT EXISTS cdr_recovery_abandonment_deliveries (
    proposal_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    message_id INTEGER NOT NULL UNIQUE CHECK(message_id>0),
    body_sha256 TEXT NOT NULL CHECK(length(body_sha256)=64 AND body_sha256 NOT GLOB '*[^0-9a-f]*')
);

-- object --

CREATE TABLE IF NOT EXISTS cdr_recovery_abandonment_decisions (
    proposal_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>0),
    ingress_id TEXT NOT NULL UNIQUE,
    interaction_id INTEGER NOT NULL UNIQUE CHECK(interaction_id>0),
    decision TEXT NOT NULL CHECK(decision IN ('abandon_only','keep_held')),
    recorded_at_bits TEXT NOT NULL
);

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_proposal_immutable
BEFORE UPDATE ON cdr_recovery_abandonment_proposals
BEGIN SELECT RAISE(ABORT,'abandonment evidence is immutable'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_proposal_no_delete
BEFORE DELETE ON cdr_recovery_abandonment_proposals
BEGIN SELECT RAISE(ABORT,'abandonment evidence cannot be forgotten'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_proposal_no_replace
BEFORE INSERT ON cdr_recovery_abandonment_proposals
WHEN EXISTS(SELECT 1 FROM cdr_recovery_abandonment_proposals WHERE id=NEW.id OR (job_id=NEW.job_id AND revision=NEW.revision))
BEGIN SELECT RAISE(ABORT,'abandonment evidence cannot be replaced'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_delivery_immutable
BEFORE UPDATE ON cdr_recovery_abandonment_deliveries
BEGIN SELECT RAISE(ABORT,'abandonment evidence is immutable'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_delivery_no_delete
BEFORE DELETE ON cdr_recovery_abandonment_deliveries
BEGIN SELECT RAISE(ABORT,'abandonment evidence cannot be forgotten'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_delivery_no_replace
BEFORE INSERT ON cdr_recovery_abandonment_deliveries
WHEN EXISTS(SELECT 1 FROM cdr_recovery_abandonment_deliveries WHERE proposal_id=NEW.proposal_id OR message_id=NEW.message_id)
BEGIN SELECT RAISE(ABORT,'abandonment evidence cannot be replaced'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_decision_immutable
BEFORE UPDATE ON cdr_recovery_abandonment_decisions
BEGIN SELECT RAISE(ABORT,'abandonment evidence is immutable'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_decision_no_delete
BEFORE DELETE ON cdr_recovery_abandonment_decisions
BEGIN SELECT RAISE(ABORT,'abandonment evidence cannot be forgotten'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_decision_no_replace
BEFORE INSERT ON cdr_recovery_abandonment_decisions
WHEN EXISTS(SELECT 1 FROM cdr_recovery_abandonment_decisions WHERE proposal_id=NEW.proposal_id OR ingress_id=NEW.ingress_id OR interaction_id=NEW.interaction_id)
BEGIN SELECT RAISE(ABORT,'abandonment evidence cannot be replaced'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_cancellation_no_update
BEFORE UPDATE ON codex_request_cancellations
WHEN EXISTS(SELECT 1 FROM cdr_recovery_abandonment_proposals p
    JOIN cdr_recovery_abandonment_decisions d ON d.proposal_id=p.id AND d.revision=p.revision
    WHERE p.job_id=OLD.job_id AND d.decision='abandon_only')
BEGIN SELECT RAISE(ABORT,'abandoned request must remain non-replayable'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_cancellation_no_delete
BEFORE DELETE ON codex_request_cancellations
WHEN EXISTS(SELECT 1 FROM cdr_recovery_abandonment_proposals p
    JOIN cdr_recovery_abandonment_decisions d ON d.proposal_id=p.id AND d.revision=p.revision
    WHERE p.job_id=OLD.job_id AND d.decision='abandon_only')
BEGIN SELECT RAISE(ABORT,'abandoned request must remain non-replayable'); END;

-- object --

CREATE TRIGGER IF NOT EXISTS cdr_recovery_abandonment_cancellation_no_replace
BEFORE INSERT ON codex_request_cancellations
WHEN EXISTS(SELECT 1 FROM codex_request_cancellations c
    JOIN cdr_recovery_abandonment_proposals p ON p.job_id=c.job_id
    JOIN cdr_recovery_abandonment_decisions d ON d.proposal_id=p.id AND d.revision=p.revision
    WHERE d.decision='abandon_only' AND (c.job_id=NEW.job_id
        OR (NEW.discord_message_id IS NOT NULL AND c.discord_message_id=NEW.discord_message_id)))
BEGIN SELECT RAISE(ABORT,'abandoned cancellation cannot be replaced'); END;
`;

function isRustWhitespace(ch: string): boolean {
  const code = ch.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function rustTrimStart(s: string): string {
  let start = 0;
  while (start < s.length && isRustWhitespace(s[start]!)) {
    start++;
  }
  return s.slice(start);
}

function rustTrimEnd(s: string): string {
  let end = s.length;
  while (end > 0 && isRustWhitespace(s[end - 1]!)) {
    end--;
  }
  return s.slice(0, end);
}

function rustTrim(s: string): string {
  return rustTrimEnd(rustTrimStart(s));
}

function rustSplitWhitespace(s: string): string[] {
  const words: string[] = [];
  let inWord = false;
  let wordStart = 0;
  for (let i = 0; i < s.length; i++) {
    if (isRustWhitespace(s[i]!)) {
      if (inWord) {
        words.push(s.slice(wordStart, i));
        inWord = false;
      }
    } else {
      if (!inWord) {
        wordStart = i;
        inWord = true;
      }
    }
  }
  if (inWord) {
    words.push(s.slice(wordStart));
  }
  return words;
}

function normalizedSql(value: string): string {
  let v = rustTrim(value);
  if (v.endsWith(';')) {
    v = v.slice(0, -1);
  }
  v = rustTrimEnd(v);
  const tablePrefix = 'CREATE TABLE IF NOT EXISTS ';
  if (v.startsWith(tablePrefix)) {
    return 'CREATE TABLE ' + v.slice(tablePrefix.length);
  }
  const triggerPrefix = 'CREATE TRIGGER IF NOT EXISTS ';
  if (v.startsWith(triggerPrefix)) {
    return 'CREATE TRIGGER ' + v.slice(triggerPrefix.length);
  }
  return v;
}

function definitions(): string[] {
  return SCHEMA.split('-- object --')
    .map(rustTrim)
    .filter((part) => part.length > 0);
}

function identity(statement: string): { kind: string; name: string } {
  const words = rustSplitWhitespace(statement);
  let idx = 0;
  if (words[idx++] !== 'CREATE') {
    throw new AbandonmentIntegrityError('invalid built-in schema definition');
  }
  const rawKind = words[idx++];
  let kind: string;
  if (rawKind === 'TABLE') {
    kind = 'table';
  } else if (rawKind === 'TRIGGER') {
    kind = 'trigger';
  } else {
    throw new AbandonmentIntegrityError('unsupported built-in schema object');
  }
  if (
    words[idx++] !== 'IF' ||
    words[idx++] !== 'NOT' ||
    words[idx++] !== 'EXISTS'
  ) {
    throw new AbandonmentIntegrityError('invalid built-in object prefix');
  }
  const name = words[idx++];
  if (!name) {
    throw new AbandonmentIntegrityError('missing built-in object name');
  }
  return { kind, name };
}

function objectCount(db: DatabaseSync): bigint {
  const row = db
    .prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name GLOB 'cdr_recovery_abandonment_*'"
    )
    .get() as { count: number | bigint } | undefined;
  if (!row) return 0n;
  return typeof row.count === 'bigint' ? row.count : BigInt(row.count);
}

function catalogMatches(db: DatabaseSync): boolean {
  let count = 0n;
  for (const definition of definitions()) {
    const { kind, name } = identity(definition);
    const row = db
      .prepare('SELECT sql FROM sqlite_schema WHERE type=? AND name=?')
      .get(kind, name) as { sql: string | null } | undefined;
    if (!row || typeof row.sql !== 'string') {
      return false;
    }
    if (normalizedSql(row.sql) !== normalizedSql(definition)) {
      return false;
    }
    count++;
  }
  return objectCount(db) === count;
}

export function schemaCurrentAbandonment(db: DatabaseSync): boolean {
  if (!catalogMatches(db)) {
    return false;
  }
  const statement = db.prepare(
    'SELECT EXISTS(SELECT 1 FROM cdr_runtime_capability_requirements WHERE component=? AND format_version=?) AS present'
  );
  statement.setReadBigInts(true);
  const row = statement.get(COMPONENT, FORMAT_VERSION) as
    | { present: bigint }
    | undefined;
  return row?.present === 1n;
}

export function migrateAbandonment(db: DatabaseSync): void {
  db.exec(SCHEMA);
  db.prepare(
    'INSERT OR IGNORE INTO cdr_runtime_capability_requirements(component,format_version) VALUES(?,?)'
  ).run(COMPONENT, FORMAT_VERSION);
  checkAbandonmentCompatibility(db, FORMAT_VERSION);
}

export function checkAbandonmentCompatibility(
  db: DatabaseSync,
  required: bigint
): void {
  if (typeof required !== 'bigint') {
    throw new TypeError('required must be a bigint');
  }
  if (required < -9223372036854775808n || required > 9223372036854775807n) {
    throw new RangeError('required must be within 64-bit signed integer range');
  }

  if (required === 0n && objectCount(db) === 0n) {
    return;
  }

  if (required !== FORMAT_VERSION || !schemaCurrentAbandonment(db)) {
    throw new AbandonmentIntegrityError(
      'unsupported or incomplete abandonment capability'
    );
  }

  db.prepare(`SELECT id,format_version,revision,job_id,target_thread_id,owner_user_id,
      channel_id,application_id,seal_json,seal_sha256
      FROM cdr_recovery_abandonment_proposals LIMIT 0`);
  db.prepare(`SELECT proposal_id,revision,message_id,body_sha256
      FROM cdr_recovery_abandonment_deliveries LIMIT 0`);
  db.prepare(`SELECT proposal_id,revision,ingress_id,interaction_id,decision,recorded_at_bits
      FROM cdr_recovery_abandonment_decisions LIMIT 0`);

  const malformedRow = db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM cdr_recovery_abandonment_proposals WHERE format_version!=1 OR revision<1)
       OR EXISTS(SELECT 1 FROM cdr_recovery_abandonment_deliveries d WHERE NOT EXISTS(
          SELECT 1 FROM cdr_recovery_abandonment_proposals p WHERE p.id=d.proposal_id AND p.revision=d.revision))
       OR EXISTS(SELECT 1 FROM cdr_recovery_abandonment_decisions d WHERE NOT EXISTS(
          SELECT 1 FROM cdr_recovery_abandonment_proposals p WHERE p.id=d.proposal_id AND p.revision=d.revision)) AS malformed`
    )
    .get() as { malformed: number | bigint } | undefined;

  const malformed =
    malformedRow !== undefined && Number(malformedRow.malformed) !== 0;

  if (malformed) {
    throw new AbandonmentIntegrityError(
      'stored abandonment evidence has no supported original proposal'
    );
  }
}
