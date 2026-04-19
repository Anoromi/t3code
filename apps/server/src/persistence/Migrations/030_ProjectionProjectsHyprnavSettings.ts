import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const DEFAULT_PROJECT_HYPRNAV_JSON =
  '{"bindings":[{"id":"worktree-terminal","slot":1,"action":"worktree-terminal"},{"id":"open-favorite-editor","slot":2,"action":"open-favorite-editor"}]}';
const DEFAULT_PROJECT_HYPRNAV_SQL_LITERAL = `'${DEFAULT_PROJECT_HYPRNAV_JSON.replaceAll("'", "''")}'`;

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

  yield* sql`
    UPDATE projection_projects
    SET hyprnav_json = ${DEFAULT_PROJECT_HYPRNAV_JSON}
    WHERE hyprnav_json IS NULL OR trim(hyprnav_json) = ''
  `;
});
