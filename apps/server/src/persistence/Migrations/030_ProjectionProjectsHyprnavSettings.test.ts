import { assert, it } from "@effect/vitest";
import { DEFAULT_PROJECT_HYPRNAV_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

const DEFAULT_PROJECT_HYPRNAV_JSON = JSON.stringify(DEFAULT_PROJECT_HYPRNAV_SETTINGS);

const prepareMigration30Fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* runMigrations({ toMigrationInclusive: 29 });
  yield* sql`
    INSERT INTO projection_projects (
      project_id,
      title,
      workspace_root,
      default_model,
      default_model_selection_json,
      scripts_json,
      worktree_group_titles_json,
      created_at,
      updated_at,
      deleted_at
    )
    VALUES (
      'project-existing',
      'Existing Project',
      '/tmp/project-existing',
      NULL,
      NULL,
      '[]',
      '[]',
      '2026-04-19T09:00:00.000Z',
      '2026-04-19T09:00:00.000Z',
      NULL
    )
  `;
});

layer("030_ProjectionProjectsHyprnavSettings", (it) => {
  it.effect("adds and backfills hyprnav settings for existing project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* prepareMigration30Fixture;

      const initialColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      assert.equal(
        initialColumns.some((column) => column.name === "hyprnav_json"),
        false,
      );

      yield* runMigrations({ toMigrationInclusive: 30 });

      const migratedColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
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
        WHERE migration_id = 30
      `;

      assert.equal(
        migratedColumns.some((column) => column.name === "hyprnav_json"),
        true,
      );
      assert.deepEqual(rows, [{ hyprnav: DEFAULT_PROJECT_HYPRNAV_JSON }]);
      assert.deepEqual(migrationRows, [
        { migrationId: 30, name: "ProjectionProjectsHyprnavSettings" },
      ]);
    }),
  );
});
