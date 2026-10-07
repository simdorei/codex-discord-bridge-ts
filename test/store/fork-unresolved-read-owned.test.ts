import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openInitialized } from "../../src/store/owned-driver.ts";
import { ensureForkHandoffTable } from "../../src/store/fork-handoff-admission.ts";
import { StoreIntegrityError } from "../../src/store/schema-assembly.ts";
import {
  unresolvedAppServerForkHandoffForSource,
  type AppServerForkHandoff,
} from "../../src/store/fork-unresolved-read.ts";

async function withTempDir(fn: (tempDir: string) => Promise<void>): Promise<void> {
  const actualTmp = await fs.realpath(os.tmpdir());
  const tempDir = await fs.mkdtemp(path.join(actualTmp, "fork-read-owned-"));
  const originalReal = await fs.realpath(tempDir);
  try {
    await fn(originalReal);
  } finally {
    const reReal = await fs.realpath(tempDir);
    const parent = path.dirname(reReal);
    if (reReal === originalReal && parent === actualTmp) {
      await fs.rm(reReal, { recursive: true, force: true });
    }
  }
}

interface InsertOptions {
  handoffId: string;
  ambiguousJobId?: string | null | undefined;
  sourceThreadId: string;
  expectedGeneration?: bigint | undefined;
  discordChannelId?: bigint | undefined;
  discordThreadId?: bigint | undefined;
  quarantineReason?: string | undefined;
  lastForkError?: string | undefined;
  forkFailureAmbiguous?: number | undefined;
  observedTargetThreadId?: string | null | undefined;
  targetThreadId?: string | null | undefined;
  completedGeneration?: bigint | null | undefined;
  createdAt?: number | undefined;
  completedAt?: number | null | undefined;
}

function insertHandoff(db: DatabaseSync, opts: InsertOptions): void {
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

describe("owned unresolvedAppServerForkHandoffForSource", () => {
  it("fresh nonexistent owned DB schema and null", async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, "fresh-store.sqlite");
      assert.equal(fsSync.existsSync(dbPath), false);

      const result = await unresolvedAppServerForkHandoffForSource(
        dbPath,
        "source-fresh",
      );
      assert.equal(result, null);
      assert.equal(fsSync.existsSync(dbPath), true);

      const verifyDb = new DatabaseSync(dbPath);
      try {
        const table = verifyDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='codex_thread_fork_handoffs'",
          )
          .get() as { name: string } | undefined;
        assert.ok(table !== undefined);
      } finally {
        verifyDb.close();
      }
    });
  });

  it("strict input before filesystem malformed Unicode and string type under owned temp", async () => {
    await withTempDir(async (tempDir) => {
      const malformedPath = path.join(tempDir, "bad-" + String.fromCharCode(0xd800) + ".sqlite");
      await assert.rejects(
        async () => {
          await unresolvedAppServerForkHandoffForSource(malformedPath, "source-1");
        },
        TypeError,
      );
      assert.equal(fsSync.existsSync(malformedPath), false);

      await assert.rejects(
        async () => {
          await unresolvedAppServerForkHandoffForSource(
            123 as unknown as string,
            "source-1",
          );
        },
        TypeError,
      );

      const validPath = path.join(tempDir, "valid-target.sqlite");
      const malformedSource = "source-" + String.fromCharCode(0xd800);
      await assert.rejects(
        async () => {
          await unresolvedAppServerForkHandoffForSource(validPath, malformedSource);
        },
        TypeError,
      );
      assert.equal(fsSync.existsSync(validPath), false);

      await assert.rejects(
        async () => {
          await unresolvedAppServerForkHandoffForSource(
            validPath,
            null as unknown as string,
          );
        },
        TypeError,
      );
      assert.equal(fsSync.existsSync(validPath), false);
    });
  });

  it("successful owned read returns exact typed record from ordinary fixture", async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, "unresolved-read.sqlite");
      const initDb = await openInitialized(dbPath);
      try {
        ensureForkHandoffTable(initDb);
        insertHandoff(initDb, {
          handoffId: "handoff-1",
          ambiguousJobId: "job-1",
          sourceThreadId: "source-1",
          expectedGeneration: -9223372036854775808n,
          discordChannelId: 9223372036854775807n,
          discordThreadId: 42n,
          quarantineReason: "manual_inspection",
          lastForkError: "recorded_failure",
          forkFailureAmbiguous: 2,
          observedTargetThreadId: null,
          targetThreadId: null,
          completedGeneration: null,
          createdAt: 12345.67,
          completedAt: null,
        });
      } finally {
        initDb.close();
      }

      const handoff = await unresolvedAppServerForkHandoffForSource(dbPath, "source-1");
      assert.ok(handoff !== null);
      const expected: AppServerForkHandoff = {
        handoffId: "handoff-1",
        ambiguousJobId: "job-1",
        sourceThreadId: "source-1",
        expectedGeneration: -9223372036854775808n,
        discordChannelId: 9223372036854775807n,
        discordThreadId: 42n,
        quarantineReason: "manual_inspection",
        lastForkError: "recorded_failure",
        forkFailureAmbiguous: true,
        observedTargetThreadId: null,
        targetThreadId: null,
        completedGeneration: null,
      };
      assert.deepStrictEqual(handoff, expected);

      const verifyDb = new DatabaseSync(dbPath);
      try {
        const row = verifyDb
          .prepare(
            "SELECT handoff_id, target_thread_id, completed_generation FROM codex_thread_fork_handoffs WHERE source_thread_id = 'source-1'",
          )
          .get() as {
            handoff_id: string;
            target_thread_id: string | null;
            completed_generation: bigint | null;
          } | undefined;
        assert.ok(row !== undefined);
        assert.equal(row.handoff_id, "handoff-1");
        assert.equal(row.target_thread_id, null);
        assert.equal(row.completed_generation, null);
      } finally {
        verifyDb.close();
      }
    });
  });

  it("resolved handoff with targetThreadId returns null", async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, "resolved-handoff.sqlite");
      const initDb = await openInitialized(dbPath);
      try {
        ensureForkHandoffTable(initDb);
        insertHandoff(initDb, {
          handoffId: "handoff-res",
          sourceThreadId: "source-res",
          observedTargetThreadId: "target-thread-1",
          targetThreadId: "target-thread-1",
          completedGeneration: 3n,
          createdAt: 1000.0,
          completedAt: 1050.0,
        });
      } finally {
        initDb.close();
      }

      const handoff = await unresolvedAppServerForkHandoffForSource(dbPath, "source-res");
      assert.equal(handoff, null);
    });
  });

  it("completed row with corrupt field throws StoreIntegrityError before filter", async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, "completed-corrupt.sqlite");
      const initDb = await openInitialized(dbPath);
      try {
        ensureForkHandoffTable(initDb);
        initDb
          .prepare(
            `INSERT INTO codex_thread_fork_handoffs (
              handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
              discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error,
              fork_failure_ambiguous, observed_target_thread_id, target_thread_id,
              completed_generation, created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "h-corrupt",
            null,
            "source-corrupt",
            "not_an_i64_int",
            1001n,
            2002n,
            "reason",
            "",
            0,
            "target-thread-1",
            "target-thread-1",
            1n,
            1000.0,
            2000.0,
          );
      } finally {
        initDb.close();
      }

      await assert.rejects(
        async () => {
          await unresolvedAppServerForkHandoffForSource(dbPath, "source-corrupt");
        },
        StoreIntegrityError,
      );
    });
  });

  it("public native bad row causes modern index drop rollback and preserves row and index", async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, "ddl-rollback.sqlite");
      const initDb = await openInitialized(dbPath);
      try {
        ensureForkHandoffTable(initDb);
        initDb.exec(
          "CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs (observed_target_thread_id);",
        );
        initDb
          .prepare(
            `INSERT INTO codex_thread_fork_handoffs (
              handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
              discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error,
              fork_failure_ambiguous, observed_target_thread_id, target_thread_id,
              completed_generation, created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "h-legacy-bad",
            null,
            "src-legacy-bad",
            1n,
            "corrupted_channel_string",
            2002n,
            "quarantine",
            "",
            0,
            null,
            null,
            null,
            1000.0,
            null,
          );
      } finally {
        initDb.close();
      }

      const beforeDb = new DatabaseSync(dbPath);
      try {
        const idx = beforeDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='codex_thread_fork_handoffs_observed_target'",
          )
          .get() as { name: string } | undefined;
        assert.ok(idx !== undefined);
        const row = beforeDb
          .prepare(
            "SELECT source_thread_id FROM codex_thread_fork_handoffs WHERE source_thread_id = 'src-legacy-bad'",
          )
          .get() as { source_thread_id: string } | undefined;
        assert.ok(row !== undefined);
      } finally {
        beforeDb.close();
      }

      await assert.rejects(
        async () => {
          await unresolvedAppServerForkHandoffForSource(dbPath, "src-legacy-bad");
        },
        StoreIntegrityError,
      );

      const afterDb = new DatabaseSync(dbPath);
      try {
        const idx = afterDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='codex_thread_fork_handoffs_observed_target'",
          )
          .get() as { name: string } | undefined;
        assert.ok(idx !== undefined, "modern dropped index preserved after DDL rollback");
        const row = afterDb
          .prepare(
            "SELECT source_thread_id FROM codex_thread_fork_handoffs WHERE source_thread_id = 'src-legacy-bad'",
          )
          .get() as { source_thread_id: string } | undefined;
        assert.ok(row !== undefined, "row preserved after rollback");
      } finally {
        afterDb.close();
      }
    });
  });

  it("legacy 3 missing columns table rolls back DDL and remains absent on bad decode", async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, "legacy-rollback.sqlite");
      const initDb = await openInitialized(dbPath);
      try {
        initDb.exec(`CREATE TABLE codex_thread_fork_handoffs (
          handoff_id TEXT PRIMARY KEY,
          ambiguous_job_id TEXT UNIQUE,
          source_thread_id TEXT NOT NULL UNIQUE,
          expected_generation INTEGER NOT NULL,
          discord_channel_id INTEGER NOT NULL,
          discord_thread_id INTEGER NOT NULL,
          quarantine_reason TEXT NOT NULL,
          target_thread_id TEXT UNIQUE,
          completed_generation INTEGER,
          created_at REAL NOT NULL,
          completed_at REAL
        );`);
        initDb.exec(
          "CREATE INDEX codex_thread_fork_handoffs_ambiguous_job ON codex_thread_fork_handoffs (ambiguous_job_id);",
        );
        initDb
          .prepare(
            `INSERT INTO codex_thread_fork_handoffs (
              handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
              discord_channel_id, discord_thread_id, quarantine_reason, target_thread_id,
              completed_generation, created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "h-legacy-bad",
            null,
            "src-legacy-bad",
            "corrupted_generation_string",
            1001n,
            2002n,
            "quarantine",
            null,
            null,
            1000.0,
            null,
          );
      } finally {
        initDb.close();
      }

      const getCols = (db: DatabaseSync): string[] =>
        (
          db
            .prepare(
              "SELECT name FROM pragma_table_info('codex_thread_fork_handoffs')",
            )
            .all() as Array<{ name: string }>
        ).map((r) => r.name);

      const beforeDb = new DatabaseSync(dbPath);
      try {
        const cols = getCols(beforeDb);
        assert.ok(!cols.includes("observed_target_thread_id"));
        assert.ok(!cols.includes("last_fork_error"));
        assert.ok(!cols.includes("fork_failure_ambiguous"));
        const idx = beforeDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='codex_thread_fork_handoffs_ambiguous_job'",
          )
          .get() as { name: string } | undefined;
        assert.ok(idx !== undefined);
      } finally {
        beforeDb.close();
      }

      await assert.rejects(
        async () => {
          await unresolvedAppServerForkHandoffForSource(dbPath, "src-legacy-bad");
        },
        StoreIntegrityError,
      );

      const afterDb = new DatabaseSync(dbPath);
      try {
        const cols = getCols(afterDb);
        assert.ok(!cols.includes("observed_target_thread_id"));
        assert.ok(!cols.includes("last_fork_error"));
        assert.ok(!cols.includes("fork_failure_ambiguous"));
        const idx = afterDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='codex_thread_fork_handoffs_ambiguous_job'",
          )
          .get() as { name: string } | undefined;
        assert.ok(idx !== undefined);
      } finally {
        afterDb.close();
      }
    });
  });

  it("real db.close first then injected close failure preserves success and primary error", async () => {
    await withTempDir(async (tempDir) => {
      const dbPath = path.join(tempDir, "close-failure.sqlite");
      const initDb = await openInitialized(dbPath);
      try {
        ensureForkHandoffTable(initDb);
        insertHandoff(initDb, {
          handoffId: "h-close-ok",
          sourceThreadId: "src-close-ok",
        });
        initDb
          .prepare(
            `INSERT INTO codex_thread_fork_handoffs (
              handoff_id, ambiguous_job_id, source_thread_id, expected_generation,
              discord_channel_id, discord_thread_id, quarantine_reason, last_fork_error,
              fork_failure_ambiguous, observed_target_thread_id, target_thread_id,
              completed_generation, created_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "h-close-err",
            null,
            "src-close-err",
            "bad-generation",
            1001n,
            2002n,
            "quarantine",
            "",
            0,
            null,
            null,
            null,
            1000.0,
            null,
          );
      } finally {
        initDb.close();
      }

      const originalClose = DatabaseSync.prototype.close;
      let closeCalls = 0;
      try {
        DatabaseSync.prototype.close = function (this: DatabaseSync) {
          closeCalls++;
          originalClose.call(this);
          throw new Error("injected close failure");
        };

        const handoff = await unresolvedAppServerForkHandoffForSource(
          dbPath,
          "src-close-ok",
        );
        assert.ok(handoff !== null);
        assert.equal(handoff.sourceThreadId, "src-close-ok");
        assert.ok(closeCalls > 0);

        await assert.rejects(
          async () => {
            await unresolvedAppServerForkHandoffForSource(dbPath, "src-close-err");
          },
          (err: unknown) => {
            assert.ok(err instanceof StoreIntegrityError);
            assert.notEqual((err as Error).message, "injected close failure");
            return true;
          },
        );
      } finally {
        DatabaseSync.prototype.close = originalClose;
      }
    });
  });

  it("persisted UTF-16LE and UTF-16BE real sentinel before close verified after reopen", async () => {
    await withTempDir(async (tempDir) => {
      const testedEncodings: string[] = [];
      for (const enc of ["UTF-16le", "UTF-16be"] as const) {
        testedEncodings.push(enc);
        const dbPath = path.join(tempDir, `sentinel-${enc.toLowerCase()}.sqlite`);
        const setupDb = new DatabaseSync(dbPath);
        try {
          setupDb.exec(`PRAGMA encoding = '${enc}';`);
          setupDb.exec("CREATE TABLE actualsentinel (val TEXT);");
          setupDb.exec("INSERT INTO actualsentinel (val) VALUES ('sentinel');");
          const setupRow = setupDb
            .prepare("SELECT encoding FROM pragma_encoding")
            .get() as { encoding: string } | undefined;
          assert.ok(setupRow !== undefined);
          assert.equal(setupRow.encoding, enc);
        } finally {
          setupDb.close();
        }

        const initDb = await openInitialized(dbPath);
        try {
          const initRow = initDb
            .prepare("SELECT encoding FROM pragma_encoding")
            .get() as { encoding: string } | undefined;
          assert.ok(initRow !== undefined);
          assert.equal(initRow.encoding, enc);

          ensureForkHandoffTable(initDb);
          insertHandoff(initDb, {
            handoffId: `h-${enc}`,
            sourceThreadId: `src-${enc}-sentinel-⚡`,
            quarantineReason: `quarantine-${enc}-🎯`,
            lastForkError: `error-${enc}-🛡️`,
          });
        } finally {
          initDb.close();
        }

        const handoff = await unresolvedAppServerForkHandoffForSource(
          dbPath,
          `src-${enc}-sentinel-⚡`,
        );
        assert.ok(handoff !== null);
        assert.equal(handoff.handoffId, `h-${enc}`);
        assert.equal(handoff.sourceThreadId, `src-${enc}-sentinel-⚡`);
        assert.equal(handoff.quarantineReason, `quarantine-${enc}-🎯`);
        assert.equal(handoff.lastForkError, `error-${enc}-🛡️`);

        const reopenDb = new DatabaseSync(dbPath);
        try {
          const row = reopenDb
            .prepare("SELECT encoding FROM pragma_encoding")
            .get() as { encoding: string } | undefined;
          assert.ok(row !== undefined);
          assert.equal(row.encoding, enc);
        } finally {
          reopenDb.close();
        }
      }
      assert.deepStrictEqual(testedEncodings, ["UTF-16le", "UTF-16be"]);
    });
  });
});
