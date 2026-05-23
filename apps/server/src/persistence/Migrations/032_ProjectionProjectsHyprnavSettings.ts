import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const DEFAULT_PROJECT_HYPRNAV_JSON = "null";
const DEFAULT_PROJECT_HYPRNAV_SQL_LITERAL = `'${DEFAULT_PROJECT_HYPRNAV_JSON.replaceAll("'", "''")}'`;
const DEFAULT_WORKTREE_GROUP_TITLES_JSON = "[]";
const DEFAULT_WORKTREE_GROUP_TITLES_SQL_LITERAL = `'${DEFAULT_WORKTREE_GROUP_TITLES_JSON}'`;

const getProjectionProjectColumnNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`.pipe(
    Effect.map((columns) => new Set(columns.map((column) => column.name))),
  );

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* getProjectionProjectColumnNames(sql);
  if (!columns.has("hyprnav_json")) {
    yield* sql.unsafe(`
      ALTER TABLE projection_projects
      ADD COLUMN hyprnav_json TEXT NOT NULL DEFAULT ${DEFAULT_PROJECT_HYPRNAV_SQL_LITERAL}
    `);
  }
  if (!columns.has("worktree_group_titles_json")) {
    yield* sql.unsafe(`
      ALTER TABLE projection_projects
      ADD COLUMN worktree_group_titles_json TEXT NOT NULL DEFAULT ${DEFAULT_WORKTREE_GROUP_TITLES_SQL_LITERAL}
    `);
  }

  yield* sql`
    UPDATE projection_projects
    SET hyprnav_json = ${DEFAULT_PROJECT_HYPRNAV_JSON}
    WHERE hyprnav_json IS NULL OR trim(hyprnav_json) = ''
  `;
  yield* sql`
    UPDATE projection_projects
    SET worktree_group_titles_json = ${DEFAULT_WORKTREE_GROUP_TITLES_JSON}
    WHERE worktree_group_titles_json IS NULL OR trim(worktree_group_titles_json) = ''
  `;
});
