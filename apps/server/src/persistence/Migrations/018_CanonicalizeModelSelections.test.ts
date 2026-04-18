import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

layer("018_CanonicalizeModelSelections", (it) => {
  it.effect("canonicalizes legacy projection model columns and event payloads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 17 });

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

      yield* runMigrations({ toMigrationInclusive: 18 });

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
      const eventRow = yield* sql<{ payloadJson: string }>`
        SELECT payload_json AS "payloadJson"
        FROM orchestration_events
        WHERE event_id = 'event-1'
      `;

      assert.equal(
        projectColumns.some((row) => row[1] === "default_model_selection_json"),
        true,
      );
      assert.equal(
        threadColumns.some((row) => row[1] === "model_selection_json"),
        true,
      );
      assert.equal(projectRow[0]?.defaultModelSelection, '{"provider":"codex","model":"gpt-5.4"}');
      assert.equal(threadRow[0]?.modelSelection, '{"provider":"codex","model":"gpt-5.4"}');
      assert.equal(
        eventRow[0]?.payloadJson,
        '{"threadId":"thread-1","projectId":"project-1","title":"Thread","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","modelSelection":{"provider":"codex","model":"gpt-5.4"}}',
      );
    }),
  );
});
