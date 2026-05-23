import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

const prepareMigration31Fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* runMigrations({ toMigrationInclusive: 32 });
  yield* sql`
    INSERT INTO projection_projects (
      project_id,
      title,
      workspace_root,
      default_model_selection_json,
      scripts_json,
      worktree_group_titles_json,
      hyprnav_json,
      created_at,
      updated_at,
      deleted_at
    )
    VALUES (
      'project-existing',
      'Existing Project',
      '/tmp/project-existing',
      NULL,
      '[]',
      '[]',
      '{"bindings":[{"id":"worktree-terminal","slot":1,"action":"worktree-terminal"},{"id":"open-favorite-editor","slot":2,"action":"open-favorite-editor"}]}',
      '2026-04-19T09:00:00.000Z',
      '2026-04-19T09:00:00.000Z',
      NULL
    )
  `;
});

layer("033_NormalizeProjectHyprnavScopes", (it) => {
  it.effect("preserves inherited hyprnav rows instead of materializing built-in defaults", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* prepareMigration31Fixture;
      yield* runMigrations({ toMigrationInclusive: 33 });

      const rows = yield* sql<{ readonly hyprnav: string }>`
        SELECT hyprnav_json AS "hyprnav"
        FROM projection_projects
        WHERE project_id = 'project-existing'
      `;
      const migrationRows = yield* sql<{
        readonly migrationId: number;
        readonly name: string;
      }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id = 33
      `;

      assert.deepEqual(rows, [{ hyprnav: "null" }]);
      assert.deepEqual(migrationRows, [{ migrationId: 33, name: "NormalizeProjectHyprnavScopes" }]);
    }),
  );
});
