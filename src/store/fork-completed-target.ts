import { openInitialized } from "./owned-driver.ts";
import { targetIsHeldIn } from "./dead-generation-admission.ts";
import { ensureForkHandoffTable } from "./fork-handoff-admission.ts";
import { decodeTextField, textDecoderFor } from "./sqlite-values.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";

export class DeadGenerationTargetHeldError extends Error {
  readonly kind = "DeadGenerationTargetHeld" as const;
  readonly targetThreadId: string;

  constructor(targetThreadId: string) {
    super(
      `conversation ${targetThreadId} is on hold after app-server process loss; manual review is required`,
    );
    this.name = "DeadGenerationTargetHeldError";
    this.targetThreadId = targetThreadId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function requireWellFormedString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`Expected a well-formed string for ${name}`);
  }
  for (const c of value) {
    const code = c.codePointAt(0);
    if (code !== undefined && code >= 0xd800 && code <= 0xdfff) {
      throw new TypeError(`Expected a well-formed string without lone surrogates for ${name}`);
    }
  }
  return value;
}

interface ForkTargetRow {
  target_thread_id: unknown;
  raw: unknown;
  encoding: unknown;
}

export async function completedAppServerForkTargetForSource(
  path: string,
  sourceThreadId: string,
): Promise<string | null> {
  requireWellFormedString(path, "path");
  requireWellFormedString(sourceThreadId, "sourceThreadId");

  const db = await openInitialized(path);
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE;");

    if (targetIsHeldIn(db, sourceThreadId)) {
      throw new DeadGenerationTargetHeldError(sourceThreadId);
    }

    ensureForkHandoffTable(db);

    const stmt = db.prepare(`SELECT target_thread_id, CAST(target_thread_id AS BLOB) AS raw,
  (SELECT encoding FROM pragma_encoding) AS encoding
FROM codex_thread_fork_handoffs
WHERE source_thread_id = ? AND completed_at IS NOT NULL`);
    stmt.setReadBigInts(true);
    const row = stmt.get(sourceThreadId) as ForkTargetRow | undefined;

    let target: string | null = null;
    if (row !== undefined) {
      const decoded = decodeTextField(
        row.target_thread_id,
        row.raw,
        "target_thread_id",
        false,
        textDecoderFor(row.encoding),
      );
      if (decoded === null) {
        throw new StoreIntegrityError(
          "Expected non-null target_thread_id for completed fork handoff",
        );
      }
      target = decoded;
    }

    db.exec("COMMIT;");
    committed = true;
    return target;
  } catch (err: unknown) {
    if (!committed) {
      try {
        db.exec("ROLLBACK;");
      } catch {
        // preserve primary failure, ignore rollback error
      }
    }
    throw err;
  } finally {
    try {
      db.close();
    } catch {
      // Rust Drop semantics: ignore close error on both success and failure paths
    }
  }
}
