import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import * as SqliteClient from "./NodeSqliteClient.ts";

const migrationNames = [
  "OrchestrationEvents",
  "OrchestrationCommandReceipts",
  "CheckpointDiffBlobs",
  "ProviderSessionRuntime",
  "Projections",
  "ProjectionThreadSessionRuntimeModeColumns",
  "ProjectionThreadMessageAttachments",
  "ProjectionThreadActivitySequence",
  "ProviderSessionRuntimeMode",
  "ProjectionThreadsRuntimeMode",
  "OrchestrationThreadCreatedRuntimeMode",
  "ProjectionThreadsInteractionMode",
  "ProjectionThreadProposedPlans",
  "ProjectionThreadProposedPlanImplementation",
  "ProjectionTurnsSourceProposedPlan",
  "CanonicalizeModelSelections",
  "ProjectionThreadsArchivedAt",
  "ProjectionThreadsArchivedAtIndex",
  "ProjectionSnapshotLookupIndexes",
] as const;

it.effect("migrates seeded worktree databases with legacy thread fork origin column names", () =>
  Effect.gen(function* () {
    const tempDir = mkdtempSync(join(tmpdir(), "t3-migrations-"));
    const dbPath = join(tempDir, "state.sqlite");

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        rmSync(tempDir, { recursive: true, force: true });
      }),
    );

    yield* Effect.sync(() => {
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE effect_sql_migrations (
          migration_id integer PRIMARY KEY NOT NULL,
          created_at datetime NOT NULL DEFAULT current_timestamp,
          name VARCHAR(255) NOT NULL
        );

        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_root TEXT NOT NULL,
          default_model TEXT,
          scripts_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT
        );

        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          title TEXT NOT NULL,
          model TEXT NOT NULL,
          branch TEXT,
          worktree_path TEXT,
          latest_turn_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          deleted_at TEXT,
          runtime_mode TEXT NOT NULL DEFAULT 'full-access',
          interaction_mode TEXT NOT NULL DEFAULT 'default',
          source_thread_id TEXT,
          source_turn_id TEXT,
          source_checkpoint_turn_count INTEGER,
          forked_at TEXT
        );

        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at,
          runtime_mode,
          interaction_mode,
          source_thread_id,
          source_turn_id,
          source_checkpoint_turn_count,
          forked_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Fork: Seeded Thread',
          'gpt-5',
          'feature/fork',
          '/tmp/worktree',
          'turn-2',
          '2026-03-22T15:30:53.000Z',
          '2026-03-22T15:30:53.000Z',
          NULL,
          'full-access',
          'default',
          'thread-source',
          'turn-source',
          3,
          '2026-03-22T15:30:53.000Z'
        );
      `);

      const insertMigration = db.prepare(`
        INSERT INTO effect_sql_migrations (migration_id, created_at, name)
        VALUES (?, '2026-03-22 15:30:53', ?)
      `);
      for (const [index, name] of migrationNames.entries()) {
        insertMigration.run(index + 1, name);
      }
      db.close();
    });

    const persistenceLayer = SqliteClient.layer({ filename: dbPath });

    yield* runMigrations({ toMigrationInclusive: 20 }).pipe(Effect.provide(persistenceLayer));

    const migratedColumns = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      const rows = yield* sql<{
        readonly forkSourceThreadId: string | null;
        readonly forkSourceTurnId: string | null;
        readonly forkSourceCheckpointTurnCount: number | null;
      }>`
        SELECT
          fork_source_thread_id AS "forkSourceThreadId",
          fork_source_turn_id AS "forkSourceTurnId",
          fork_source_checkpoint_turn_count AS "forkSourceCheckpointTurnCount"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;

      return {
        columnNames: new Set(columns.map((column) => column.name)),
        row: rows[0] ?? null,
      };
    }).pipe(Effect.provide(persistenceLayer));

    assert.ok(migratedColumns.columnNames.has("fork_source_thread_id"));
    assert.ok(migratedColumns.columnNames.has("fork_source_turn_id"));
    assert.ok(migratedColumns.columnNames.has("fork_source_checkpoint_turn_count"));
    assert.equal(migratedColumns.columnNames.has("source_thread_id"), false);
    assert.equal(migratedColumns.columnNames.has("source_turn_id"), false);
    assert.equal(migratedColumns.columnNames.has("source_checkpoint_turn_count"), false);
    assert.deepEqual(migratedColumns.row, {
      forkSourceThreadId: "thread-source",
      forkSourceTurnId: "turn-source",
      forkSourceCheckpointTurnCount: 3,
    });
  }),
);
