import type { DatabaseSync } from "node:sqlite";
import { rustDebugString } from "../core/rust-debug.ts";
import { decodeTextField, textDecoderFor, decodeI64, decodeOptionalI64, decodeBool } from "./sqlite-values.ts";

export class ForkHandoffUnresolvedError extends Error {
  readonly kind = "ForkHandoffUnresolved" as const;
  readonly targetThreadId: string;
  readonly lastError: string | null;
  constructor(targetThreadId: string, lastError: string | null) {
    super(`app-server fork handoff is unresolved for target thread ${targetThreadId}: ${lastError === null ? "None" : "Some(" + rustDebugString(lastError) + ")"}`);
    this.name="ForkHandoffUnresolvedError";
    this.targetThreadId=targetThreadId;
    this.lastError=lastError;
  }
}
export class ForkHandoffTargetMovedError extends Error {
  readonly kind = "ForkHandoffTargetMoved" as const;
  readonly sourceThreadId: string;
  readonly targetThreadId: string;
  constructor(sourceThreadId: string, targetThreadId: string) {
    super(`app-server fork handoff moved source thread ${sourceThreadId} to ${targetThreadId}`);
    this.name="ForkHandoffTargetMovedError";
    this.sourceThreadId=sourceThreadId;
    this.targetThreadId=targetThreadId;
  }
}
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS codex_thread_fork_handoffs (
  handoff_id TEXT PRIMARY KEY,
  ambiguous_job_id TEXT UNIQUE,
  source_thread_id TEXT NOT NULL UNIQUE,
  expected_generation INTEGER NOT NULL,
  discord_channel_id INTEGER NOT NULL,
  discord_thread_id INTEGER NOT NULL,
  quarantine_reason TEXT NOT NULL,
  last_fork_error TEXT NOT NULL DEFAULT '',
  fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,
  observed_target_thread_id TEXT,
  target_thread_id TEXT UNIQUE,
  completed_generation INTEGER,
  created_at REAL NOT NULL,
  completed_at REAL,
  CHECK ((target_thread_id IS NULL AND completed_generation IS NULL AND completed_at IS NULL)
    OR (target_thread_id IS NOT NULL AND completed_generation IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (target_thread_id IS NULL OR target_thread_id = observed_target_thread_id)
)`;
function requireText(value: string): void {
  if (typeof value !== "string") throw new TypeError("Expected a well-formed string");
  for (const c of value) {
    const p=c.codePointAt(0)!;
    if(p>=0xd800 && p<=0xdfff) throw new TypeError("Expected a well-formed string");
  }
}
export function ensureForkHandoffTable(db: DatabaseSync): void {
  db.exec(CREATE_TABLE);
  const columns=db.prepare(`SELECT name,CAST(name AS BLOB) AS raw,
    (SELECT encoding FROM pragma_encoding) AS encoding
    FROM pragma_table_info('codex_thread_fork_handoffs')`).all().map(row =>
      decodeTextField(row.name,row.raw,"name",false,textDecoderFor(row.encoding))!);
  if(!columns.includes("observed_target_thread_id")) {
    db.exec("ALTER TABLE codex_thread_fork_handoffs ADD COLUMN observed_target_thread_id TEXT");
  }
  if(!columns.includes("last_fork_error")) {
    db.exec("ALTER TABLE codex_thread_fork_handoffs ADD COLUMN last_fork_error TEXT NOT NULL DEFAULT ''");
  }
  if(!columns.includes("fork_failure_ambiguous")) {
    db.exec("ALTER TABLE codex_thread_fork_handoffs ADD COLUMN fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0");
  }
  db.exec("DROP INDEX IF EXISTS codex_thread_fork_handoffs_observed_target");
}
const TEXT_FIELDS=["handoff_id","ambiguous_job_id","source_thread_id","quarantine_reason",
  "last_fork_error","observed_target_thread_id","target_thread_id"] as const;
const COLUMNS="handoff_id,ambiguous_job_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,last_fork_error,fork_failure_ambiguous,observed_target_thread_id,target_thread_id,completed_generation";
const RAW_FIELDS=TEXT_FIELDS.map(name=>`CAST(${name} AS BLOB) AS b_${name}`).join(",");
const RUST_WHITESPACE_ONLY=/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

export function ensureNoUnresolvedHandoff(db: DatabaseSync, target: string): void {
  requireText(target);
  ensureForkHandoffTable(db);
  const stmt=db.prepare(`SELECT ${COLUMNS},${RAW_FIELDS},
    (SELECT encoding FROM pragma_encoding) AS encoding
    FROM codex_thread_fork_handoffs WHERE source_thread_id=?`);
  stmt.setReadBigInts(true);
  const row=stmt.get(target);
  if(row===undefined) return;
  const decoder=textDecoderFor(row.encoding);
  const text=(name: string, optional=false) => decodeTextField(row[name],row["b_"+name],name,optional,decoder);
  // Rust constructs the entire typed handoff before filtering completed rows.
  text("handoff_id"); text("ambiguous_job_id",true); text("source_thread_id");
  decodeI64(row.expected_generation,"expected_generation");
  decodeI64(row.discord_channel_id,"discord_channel_id");
  decodeI64(row.discord_thread_id,"discord_thread_id");
  text("quarantine_reason");
  const lastError=text("last_fork_error")!;
  decodeBool(row.fork_failure_ambiguous,"fork_failure_ambiguous");
  text("observed_target_thread_id",true);
  const completedTarget=text("target_thread_id",true);
  decodeOptionalI64(row.completed_generation,"completed_generation");
  if(completedTarget===null) {
    throw new ForkHandoffUnresolvedError(target,RUST_WHITESPACE_ONLY.test(lastError)?null:lastError);
  }
}
export function ensureSourceNotMoved(db: DatabaseSync, source: string): void {
  requireText(source);
  const enabled=db.prepare("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_exact_thread_routing') AS enabled");
  enabled.setReadBigInts(true);
  if(decodeBool(enabled.get()!.enabled,"enabled")) return;
  ensureForkHandoffTable(db);
  const row=db.prepare(`SELECT target_thread_id,CAST(target_thread_id AS BLOB) AS raw,
    (SELECT encoding FROM pragma_encoding) AS encoding
    FROM codex_thread_fork_handoffs WHERE source_thread_id=? AND completed_at IS NOT NULL`).get(source);
  if(row!==undefined) {
    const target=decodeTextField(row.target_thread_id,row.raw,"target_thread_id",false,textDecoderFor(row.encoding))!;
    throw new ForkHandoffTargetMovedError(source,target);
  }
}
