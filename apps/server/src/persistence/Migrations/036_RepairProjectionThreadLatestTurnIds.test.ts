import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("036_RepairProjectionThreadLatestTurnIds", (it) => {
  it.effect("backfills missing latest turn ids from existing projection turns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          scripts_json,
          created_at,
          updated_at
        )
        VALUES (
          'project-latest-turn-repair',
          'Project',
          '/tmp/project-latest-turn-repair',
          '[]',
          '2026-05-30T12:00:00.000Z',
          '2026-05-30T12:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          latest_turn_id,
          created_at,
          updated_at,
          runtime_mode,
          interaction_mode,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan
        )
        VALUES (
          'thread-latest-turn-repair',
          'project-latest-turn-repair',
          'Thread',
          '{"provider":"codex","model":"gpt-5"}',
          NULL,
          '2026-05-30T12:00:00.000Z',
          '2026-05-30T12:00:00.000Z',
          'full-access',
          'plan',
          0,
          0,
          1
        )
      `;
      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_files_json
        )
        VALUES (
          'thread-latest-turn-repair',
          'turn-latest-turn-repair',
          'completed',
          '2026-05-30T12:01:00.000Z',
          '2026-05-30T12:01:01.000Z',
          '2026-05-30T12:02:00.000Z',
          '[]'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{ readonly latestTurnId: string | null }>`
        SELECT latest_turn_id AS "latestTurnId"
        FROM projection_threads
        WHERE thread_id = 'thread-latest-turn-repair'
      `;
      assert.deepEqual(rows, [{ latestTurnId: "turn-latest-turn-repair" }]);
    }),
  );
});
