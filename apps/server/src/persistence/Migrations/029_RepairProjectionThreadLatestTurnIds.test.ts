import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

const modelSelectionJson = '{"provider":"codex","model":"gpt-5-codex"}';

function insertThread(input: { readonly threadId: string; readonly latestTurnId: string | null }) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      INSERT INTO projection_threads (
        thread_id,
        project_id,
        title,
        model,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        branch,
        worktree_path,
        fork_source_thread_id,
        fork_source_turn_id,
        fork_source_checkpoint_turn_count,
        forked_at,
        latest_turn_id,
        created_at,
        updated_at,
        archived_at,
        latest_user_message_at,
        pending_approval_count,
        pending_user_input_count,
        has_actionable_proposed_plan,
        deleted_at
      )
      VALUES (
        ${input.threadId},
        'project-1',
        'Projection Thread',
        'gpt-5-codex',
        ${modelSelectionJson},
        'full-access',
        'default',
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        ${input.latestTurnId},
        '2026-04-19T09:00:00.000Z',
        '2026-04-19T09:00:00.000Z',
        NULL,
        NULL,
        0,
        0,
        0,
        NULL
      )
    `;
  });
}

function insertTurn(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly checkpointTurnCount?: number | null;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      INSERT INTO projection_turns (
        thread_id,
        turn_id,
        pending_message_id,
        source_proposed_plan_thread_id,
        source_proposed_plan_id,
        assistant_message_id,
        state,
        requested_at,
        started_at,
        completed_at,
        checkpoint_turn_count,
        checkpoint_ref,
        checkpoint_status,
        checkpoint_files_json
      )
      VALUES (
        ${input.threadId},
        ${input.turnId},
        NULL,
        NULL,
        NULL,
        NULL,
        ${input.completedAt === null ? "running" : "completed"},
        ${input.requestedAt},
        ${input.startedAt},
        ${input.completedAt},
        ${input.checkpointTurnCount ?? null},
        NULL,
        NULL,
        '[]'
      )
    `;
  });
}

const getLatestTurnId = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly latestTurnId: string | null }>`
      SELECT latest_turn_id AS "latestTurnId"
      FROM projection_threads
      WHERE thread_id = ${threadId}
    `;
    return rows[0]?.latestTurnId ?? null;
  });

const createMigrationLedgerThrough28 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS effect_sql_migrations`;
  yield* sql`
    CREATE TABLE effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;

  for (const [migrationId, name] of migrationEntries) {
    if (migrationId > 28) {
      continue;
    }

    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${migrationId}, ${name})
    `;
  }
});

const prepareMigration29Fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* runMigrations({ toMigrationInclusive: 28 });
  yield* sql`DELETE FROM projection_turns`;
  yield* sql`DELETE FROM projection_threads`;
  yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 29`;
});

layer("029_RepairProjectionThreadLatestTurnIds", (it) => {
  it.effect("repairs null latest turn ids from existing concrete turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* prepareMigration29Fixture;
      yield* insertThread({ threadId: "thread-null-latest", latestTurnId: null });
      yield* insertTurn({
        threadId: "thread-null-latest",
        turnId: "turn-old",
        requestedAt: "2026-04-19T09:00:00.000Z",
        startedAt: "2026-04-19T09:00:00.000Z",
        completedAt: "2026-04-19T09:01:00.000Z",
      });
      yield* insertTurn({
        threadId: "thread-null-latest",
        turnId: "turn-new",
        requestedAt: "2026-04-19T09:10:00.000Z",
        startedAt: "2026-04-19T09:10:00.000Z",
        completedAt: "2026-04-19T09:11:00.000Z",
        checkpointTurnCount: 2,
      });

      yield* runMigrations({ toMigrationInclusive: 29 });

      const latestTurnId = yield* getLatestTurnId("thread-null-latest");
      const repairRows = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 29
      `;

      assert.equal(latestTurnId, "turn-new");
      assert.deepEqual(repairRows, [
        { migrationId: 29, name: "RepairProjectionThreadLatestTurnIds" },
      ]);
    }),
  );

  it.effect("preserves valid latest turn ids", () =>
    Effect.gen(function* () {
      yield* prepareMigration29Fixture;
      yield* insertThread({ threadId: "thread-valid-latest", latestTurnId: "turn-old" });
      yield* insertTurn({
        threadId: "thread-valid-latest",
        turnId: "turn-old",
        requestedAt: "2026-04-19T09:00:00.000Z",
        startedAt: "2026-04-19T09:00:00.000Z",
        completedAt: "2026-04-19T09:01:00.000Z",
      });
      yield* insertTurn({
        threadId: "thread-valid-latest",
        turnId: "turn-new",
        requestedAt: "2026-04-19T09:10:00.000Z",
        startedAt: "2026-04-19T09:10:00.000Z",
        completedAt: "2026-04-19T09:11:00.000Z",
      });

      yield* runMigrations({ toMigrationInclusive: 29 });

      const latestTurnId = yield* getLatestTurnId("thread-valid-latest");
      assert.equal(latestTurnId, "turn-old");
    }),
  );

  it.effect("repairs dangling latest turn ids", () =>
    Effect.gen(function* () {
      yield* prepareMigration29Fixture;
      yield* insertThread({ threadId: "thread-dangling-latest", latestTurnId: "missing-turn" });
      yield* insertTurn({
        threadId: "thread-dangling-latest",
        turnId: "turn-existing",
        requestedAt: "2026-04-19T09:00:00.000Z",
        startedAt: "2026-04-19T09:00:00.000Z",
        completedAt: "2026-04-19T09:01:00.000Z",
      });

      yield* runMigrations({ toMigrationInclusive: 29 });

      const latestTurnId = yield* getLatestTurnId("thread-dangling-latest");
      assert.equal(latestTurnId, "turn-existing");
    }),
  );

  it.effect("leaves empty-history threads untouched", () =>
    Effect.gen(function* () {
      yield* prepareMigration29Fixture;
      yield* insertThread({ threadId: "thread-empty-history", latestTurnId: null });

      yield* runMigrations({ toMigrationInclusive: 29 });

      const latestTurnId = yield* getLatestTurnId("thread-empty-history");
      assert.equal(latestTurnId, null);
    }),
  );

  it.effect("records successfully when projection_turns is absent from a partial schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* createMigrationLedgerThrough28;
      yield* sql`DROP TABLE IF EXISTS projection_turns`;
      yield* sql`DROP TABLE IF EXISTS projection_threads`;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          latest_turn_id TEXT
        )
      `;

      yield* runMigrations();

      const repairRows = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 29
      `;

      assert.deepEqual(repairRows, [
        { migrationId: 29, name: "RepairProjectionThreadLatestTurnIds" },
      ]);
    }),
  );
});
