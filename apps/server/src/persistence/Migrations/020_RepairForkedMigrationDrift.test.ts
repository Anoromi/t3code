import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("020_RepairForkedMigrationDrift", (it) => {
  it.effect(
    "repairs databases that recorded forked migrations before canonical model selection migration",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations({ toMigrationInclusive: 15 });

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project',
          '/tmp/project',
          'gpt-5.4',
          '[]',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL
        )
      `;

        yield* sql`
        ALTER TABLE projection_projects
        ADD COLUMN worktree_group_titles_json TEXT NOT NULL DEFAULT '[]'
      `;

        yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN fork_source_thread_id TEXT
      `;
        yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN fork_source_turn_id TEXT
      `;
        yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN fork_source_checkpoint_turn_count INTEGER
      `;
        yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN forked_at TEXT
      `;

        yield* sql`
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
          fork_source_thread_id,
          fork_source_turn_id,
          fork_source_checkpoint_turn_count,
          forked_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread',
          'gpt-5.4',
          NULL,
          NULL,
          NULL,
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
          NULL,
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL
        )
      `;

        yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          'event-1',
          'project',
          'project-1',
          0,
          'project.created',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          'server',
          '{"projectId":"project-1","title":"Project","workspaceRoot":"/tmp/project","defaultModel":"gpt-5.4","scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        ),
        (
          'event-2',
          'thread',
          'thread-1',
          0,
          'thread.created',
          '2026-01-01T00:00:00.000Z',
          NULL,
          NULL,
          NULL,
          'server',
          '{"threadId":"thread-1","projectId":"project-1","title":"Thread","model":"gpt-5.4","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
          '{}'
        )
      `;

        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (16, 'ProjectionThreadsForkOrigin'),
          (17, 'ProjectionThreadsForkOriginCompat'),
          (18, 'ProjectionProjectsWorktreeGroupTitles')
      `;

        yield* runMigrations({ toMigrationInclusive: 20 });

        const projectColumns = yield* sql`PRAGMA table_info(projection_projects)`.values;
        const threadColumns = yield* sql`PRAGMA table_info(projection_threads)`.values;
        const projectRow = yield* sql<{ defaultModelSelection: string | null }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-1'
      `;
        const threadRow = yield* sql<{ modelSelection: string | null }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
        const eventRows = yield* sql<{ eventId: string; payloadJson: string }>`
        SELECT event_id AS "eventId", payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_id IN ('event-1', 'event-2')
        ORDER BY event_id ASC
      `;
        const migrationRows = yield* sql<{ migrationId: number; name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id >= 19
        ORDER BY migration_id ASC
      `;

        assert.equal(
          projectColumns.some((row) => row[1] === "default_model_selection_json"),
          true,
        );
        assert.equal(
          threadColumns.some((row) => row[1] === "model_selection_json"),
          true,
        );
        assert.equal(
          projectRow[0]?.defaultModelSelection,
          '{"provider":"codex","model":"gpt-5.4"}',
        );
        assert.equal(threadRow[0]?.modelSelection, '{"provider":"codex","model":"gpt-5.4"}');
        assert.deepEqual(eventRows, [
          {
            eventId: "event-1",
            payloadJson:
              '{"projectId":"project-1","title":"Project","workspaceRoot":"/tmp/project","scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","defaultModelSelection":{"provider":"codex","model":"gpt-5.4"}}',
          },
          {
            eventId: "event-2",
            payloadJson:
              '{"threadId":"thread-1","projectId":"project-1","title":"Thread","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","modelSelection":{"provider":"codex","model":"gpt-5.4"}}',
          },
        ]);
        assert.deepEqual(migrationRows, [
          { migrationId: 19, name: "ProjectionProjectsWorktreeGroupTitles" },
          { migrationId: 20, name: "RepairForkedMigrationDrift" },
        ]);
      }),
  );
});
