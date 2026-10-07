import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { ensureForkHandoffTable } from "../../src/store/fork-handoff-admission.ts";
import { unresolvedHandoffIn } from "../../src/store/fork-unresolved-read.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";

function withTempDb<T>(fn: (db: DatabaseSync) => T): T {
  const realTmp = fs.realpathSync(os.tmpdir());
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(realTmp, "fork-unres-")));
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path.join(dir, "store.sqlite"));
    return fn(db);
  } finally {
    try {
      db?.close();
    } finally {
      if (fs.existsSync(dir)) {
        const resolved = fs.realpathSync(dir);
        if (resolved === dir && path.dirname(resolved) === realTmp) {
          fs.rmSync(resolved, { recursive: true, force: true });
        }
      }
    }
  }
}

interface InsertHandoffOptions {
  handoffId: string;
  ambiguousJobId?: string | null | undefined;
  sourceThreadId: string;
  expectedGeneration?: bigint | number | string | undefined;
  discordChannelId?: bigint | number | string | undefined;
  discordThreadId?: bigint | number | string | undefined;
  quarantineReason?: SQLInputValue | undefined;
  lastForkError?: string | undefined;
  forkFailureAmbiguous?: SQLInputValue | undefined;
  observedTargetThreadId?: string | null | undefined;
  targetThreadId?: string | null | undefined;
  completedGeneration?: bigint | number | string | null | undefined;
  createdAt?: number | undefined;
  completedAt?: number | null | undefined;
}

function insertHandoff(db: DatabaseSync, opts: InsertHandoffOptions): void {
  ensureForkHandoffTable(db);
  db.prepare(
    `INSERT INTO codex_thread_fork_handoffs (
      handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
      discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error,
      fork_failure_ambiguous, observed_target_thread_id, target_thread_id,
      completed_generation, created_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.handoffId,
    opts.ambiguousJobId ?? null,
    opts.sourceThreadId,
    opts.expectedGeneration ?? 1n,
    opts.discordChannelId ?? 1001n,
    opts.discordThreadId ?? 2002n,
    opts.quarantineReason ?? "manual_fork",
    opts.lastForkError ?? "",
    opts.forkFailureAmbiguous ?? 0,
    opts.observedTargetThreadId ?? null,
    opts.targetThreadId ?? null,
    opts.completedGeneration ?? null,
    opts.createdAt ?? 1000.0,
    opts.completedAt ?? null,
  );
}

test("1. all 12 exact typed fields, nulls, nonzero bool, and signed i64 extremes", () => {
  withTempDb((db) => {
    const minI64 = -9223372036854775808n;
    const maxI64 = 9223372036854775807n;
    insertHandoff(db, {
      handoffId: "h_ext",
      ambiguousJobId: null,
      sourceThreadId: "src_ext",
      expectedGeneration: minI64,
      discordChannelId: maxI64,
      discordThreadId: 0n,
      quarantineReason: "quarantine_ext",
      lastForkError: "last_err_ext",
      forkFailureAmbiguous: 42,
      observedTargetThreadId: null,
      targetThreadId: null,
      completedGeneration: null,
    });

    const handoff = unresolvedHandoffIn(db, "src_ext");
    assert.deepEqual(handoff, {
      handoffId: "h_ext",
      ambiguousJobId: null,
      sourceThreadId: "src_ext",
      expectedGeneration: minI64,
      discordChannelId: maxI64,
      discordThreadId: 0n,
      quarantineReason: "quarantine_ext",
      lastForkError: "last_err_ext",
      forkFailureAmbiguous: true,
      observedTargetThreadId: null,
      targetThreadId: null,
      completedGeneration: null,
    });
  });
});

test("2. observed-only target returns unresolved handoff with matching fields", () => {
  withTempDb((db) => {
    insertHandoff(db, {
      handoffId: "h_obs",
      ambiguousJobId: "job_obs",
      sourceThreadId: "src_obs",
      expectedGeneration: 5n,
      discordChannelId: 10n,
      discordThreadId: 20n,
      quarantineReason: "manual",
      lastForkError: "",
      forkFailureAmbiguous: 0,
      observedTargetThreadId: "target_observed_1",
      targetThreadId: null,
      completedGeneration: null,
    });

    const handoff = unresolvedHandoffIn(db, "src_obs");
    assert.ok(handoff !== null);
    assert.equal(handoff.observedTargetThreadId, "target_observed_1");
    assert.equal(handoff.targetThreadId, null);
    assert.equal(handoff.ambiguousJobId, "job_obs");
    assert.equal(handoff.forkFailureAmbiguous, false);
  });
});

test("3. completed valid row and empty string target completed row return null", () => {
  withTempDb((db) => {
    insertHandoff(db, {
      handoffId: "h_done",
      sourceThreadId: "src_done",
      observedTargetThreadId: "tgt_done",
      targetThreadId: "tgt_done",
      completedGeneration: 3n,
      completedAt: 2000.0,
    });
    assert.equal(unresolvedHandoffIn(db, "src_done"), null);

    insertHandoff(db, {
      handoffId: "h_empty_done",
      sourceThreadId: "src_empty_done",
      observedTargetThreadId: "",
      targetThreadId: "",
      completedGeneration: 1n,
      completedAt: 2000.0,
    });
    assert.equal(unresolvedHandoffIn(db, "src_empty_done"), null);
  });
});

test("4. completed row with corrupt field throws before filter", () => {
  withTempDb((db) => {
    ensureForkHandoffTable(db);
    db.prepare(
      `INSERT INTO codex_thread_fork_handoffs (
        handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
        discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error,
        fork_failure_ambiguous, observed_target_thread_id, target_thread_id,
        completed_generation, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "h_corrupt_done",
      null,
      "src_corrupt_done",
      "corrupt_text_expected_gen",
      1001n,
      2002n,
      "quarantine",
      "",
      0,
      "tgt_done",
      "tgt_done",
      1n,
      1000.0,
      2000.0,
    );

    assert.throws(
      () => unresolvedHandoffIn(db, "src_corrupt_done"),
      StoreIntegrityError,
    );
  });
});

test("5. sourceThreadId validation rejects non-string and lone surrogates before DB access", () => {
  withTempDb((db) => {
    assert.throws(
      () => unresolvedHandoffIn(db, null as unknown as string),
      TypeError,
    );
    assert.throws(
      () => unresolvedHandoffIn(db, 12345 as unknown as string),
      TypeError,
    );
    assert.throws(
      () => unresolvedHandoffIn(db, "bad\uD800surrogate"),
      TypeError,
    );
    assert.throws(
      () => unresolvedHandoffIn(db, "lone\uDFFFsuffix"),
      TypeError,
    );

    const row = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_thread_fork_handoffs'",
    ).get();
    assert.equal(row, undefined);
  });
});

test("6. exact Unicode identities (NUL, BOM, astral/supp, whitespace) preserved without trim", () => {
  withTempDb((db) => {
    const complexSource = "\uFEFF\0\u{1F980}  source  \t\r\n";
    const preservedWhitespaceError = "  \t\n  ";
    const complexReason = "\0embedded\u{1F600}reason";
    insertHandoff(db, {
      handoffId: "h_unicode",
      sourceThreadId: complexSource,
      lastForkError: preservedWhitespaceError,
      quarantineReason: complexReason,
    });

    const handoff = unresolvedHandoffIn(db, complexSource);
    assert.ok(handoff !== null);
    assert.equal(handoff.sourceThreadId, complexSource);
    assert.equal(handoff.lastForkError, preservedWhitespaceError);
    assert.equal(handoff.quarantineReason, complexReason);
  });
});

test("7. BLOB storage class in TEXT column throws StoreIntegrityError", () => {
  withTempDb((db) => {
    insertHandoff(db, {
      handoffId: "h_blob_storage",
      sourceThreadId: "src_blob_storage",
      quarantineReason: "initial",
    });

    db.prepare(
      "UPDATE codex_thread_fork_handoffs SET quarantine_reason = X'FFFE' WHERE source_thread_id = ?",
    ).run("src_blob_storage");

    const probe = db.prepare(
      "SELECT typeof(quarantine_reason) AS t FROM codex_thread_fork_handoffs WHERE source_thread_id = ?",
    ).get("src_blob_storage") as { t: string } | undefined;
    assert.equal(probe?.t, "blob");

    assert.throws(
      () => unresolvedHandoffIn(db, "src_blob_storage"),
      StoreIntegrityError,
    );
  });
});

test("7b. malformed UTF-8 bytes in native TEXT column throw StoreIntegrityError", () => {
  withTempDb((db) => {
    insertHandoff(db, {
      handoffId: "h_invalid_utf8",
      sourceThreadId: "src_invalid_utf8",
      quarantineReason: "initial",
    });

    db.prepare(
      "UPDATE codex_thread_fork_handoffs SET quarantine_reason = CAST(X'FF' AS TEXT) WHERE source_thread_id = ?",
    ).run("src_invalid_utf8");

    const probe = db.prepare(
      "SELECT typeof(quarantine_reason) AS t FROM codex_thread_fork_handoffs WHERE source_thread_id = ?",
    ).get("src_invalid_utf8") as { t: string } | undefined;
    assert.equal(probe?.t, "text");

    assert.throws(
      () => unresolvedHandoffIn(db, "src_invalid_utf8"),
      StoreIntegrityError,
    );
  });
});

test("8. malformed INTEGER, REAL, and boolean column types throw StoreIntegrityError", () => {
  withTempDb((db) => {
    insertHandoff(db, {
      handoffId: "h_bad_types",
      sourceThreadId: "src_bad_types",
    });

    const validUnresolved = unresolvedHandoffIn(db, "src_bad_types");
    assert.ok(validUnresolved !== null);
    assert.equal(validUnresolved.completedGeneration, null);

    const unresolvedMatrix: Array<[string, SQLInputValue]> = [
      ["fork_failure_ambiguous", 3.14],
      ["fork_failure_ambiguous", "not_bool"],
      ["expected_generation", 1.5],
      ["expected_generation", "not_int"],
      ["discord_channel_id", 1.5],
      ["discord_channel_id", "not_int"],
      ["discord_thread_id", 1.5],
      ["discord_thread_id", "not_int"],
    ];

    for (const [col, val] of unresolvedMatrix) {
      db.prepare(
        `UPDATE codex_thread_fork_handoffs SET
          expected_generation = 1,
          discord_channel_id = 1001,
          discord_thread_id = 2002,
          fork_failure_ambiguous = 0
        WHERE source_thread_id = ?`,
      ).run("src_bad_types");

      db.prepare(
        `UPDATE codex_thread_fork_handoffs SET ${col} = ? WHERE source_thread_id = ?`,
      ).run(val, "src_bad_types");

      assert.throws(
        () => unresolvedHandoffIn(db, "src_bad_types"),
        StoreIntegrityError,
      );
    }

    db.prepare(
      "UPDATE codex_thread_fork_handoffs SET expected_generation = 9223372036854775808 WHERE source_thread_id = ?",
    ).run("src_bad_types");
    assert.throws(
      () => unresolvedHandoffIn(db, "src_bad_types"),
      StoreIntegrityError,
    );

    const completedMatrix: readonly (number | string)[] = [1.5, "not_int"];
    let compIdx = 0;
    for (const val of completedMatrix) {
      const sid = `src_bad_completed_${compIdx++}`;
      insertHandoff(db, {
        handoffId: `h_${sid}`,
        sourceThreadId: sid,
        observedTargetThreadId: `tgt_${sid}`,
        targetThreadId: `tgt_${sid}`,
        completedGeneration: val,
        completedAt: 2000.0,
      });
      assert.throws(
        () => unresolvedHandoffIn(db, sid),
        StoreIntegrityError,
      );
    }
  });
});

test("9. unrelated corrupt row is ignored when reading a valid source thread", () => {
  withTempDb((db) => {
    insertHandoff(db, {
      handoffId: "h_corrupt_other",
      sourceThreadId: "src_corrupt_other",
    });
    insertHandoff(db, {
      handoffId: "h_valid",
      sourceThreadId: "src_valid",
    });

    db.prepare(
      "UPDATE codex_thread_fork_handoffs SET quarantine_reason = X'FF' WHERE source_thread_id = ?",
    ).run("src_corrupt_other");

    const handoff = unresolvedHandoffIn(db, "src_valid");
    assert.ok(handoff !== null);
    assert.equal(handoff.handoffId, "h_valid");
    assert.equal(handoff.sourceThreadId, "src_valid");
  });
});

test("10. first matching duplicate legacy row is returned without error", () => {
  withTempDb((db) => {
    db.exec(
      `CREATE TABLE codex_thread_fork_handoffs (
        handoff_id TEXT PRIMARY KEY,
        ambiguous_job_id TEXT,
        source_thread_id TEXT NOT NULL,
        expected_generation INTEGER NOT NULL,
        discord_channel_id INTEGER NOT NULL,
        discord_thread_id INTEGER NOT NULL,
        quarantine_reason TEXT NOT NULL,
        last_fork_error TEXT NOT NULL DEFAULT '',
        fork_failure_ambiguous INTEGER NOT NULL DEFAULT 0,
        observed_target_thread_id TEXT,
        target_thread_id TEXT,
        completed_generation INTEGER,
        created_at REAL NOT NULL,
        completed_at REAL
      )`,
    );

    insertHandoff(db, {
      handoffId: "h_first",
      sourceThreadId: "src_dup",
    });
    insertHandoff(db, {
      handoffId: "h_second",
      sourceThreadId: "src_dup",
    });

    const handoff = unresolvedHandoffIn(db, "src_dup");
    assert.ok(handoff !== null);
    assert.equal(handoff.handoffId, "h_first");
  });
});

test("11. caller-owned transaction DDL rollback leaves handle alive and caller controls transaction", () => {
  withTempDb((db) => {
    db.exec("BEGIN IMMEDIATE;");
    const handoff = unresolvedHandoffIn(db, "src_missing");
    assert.equal(handoff, null);
    db.exec("ROLLBACK;");

    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_thread_fork_handoffs'",
    ).get();
    assert.equal(table, undefined);

    db.exec("CREATE TABLE probe (val INTEGER);");
    db.prepare("INSERT INTO probe VALUES (1);").run();
    const probeRow = db.prepare("SELECT val FROM probe;").get() as { val: number } | undefined;
    assert.equal(probeRow?.val, 1);
  });
});

test("12. non-existent source thread and empty table return null", () => {
  withTempDb((db) => {
    ensureForkHandoffTable(db);
    assert.equal(unresolvedHandoffIn(db, "src_empty_table"), null);

    insertHandoff(db, {
      handoffId: "h_existing",
      sourceThreadId: "src_existing",
    });
    assert.equal(unresolvedHandoffIn(db, "src_nonexistent"), null);
  });
});
