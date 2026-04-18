import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const getProjectionThreadColumns = (sql: SqlClient.SqlClient) =>
  sql`PRAGMA table_info(projection_threads)`.values.pipe(
    Effect.map(
      (rows) => new Set(rows.flatMap((row) => (typeof row[1] === "string" ? [row[1]] : []))),
    ),
  );

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* getProjectionThreadColumns(sql);

  if (!columns.has("archived_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN archived_at TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_project_archived_at
    ON projection_threads(project_id, archived_at)
  `;

  if (columns.has("source_thread_id") && !columns.has("fork_source_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      RENAME COLUMN source_thread_id TO fork_source_thread_id
    `;
  }

  if (columns.has("source_turn_id") && !columns.has("fork_source_turn_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      RENAME COLUMN source_turn_id TO fork_source_turn_id
    `;
  }

  if (
    columns.has("source_checkpoint_turn_count") &&
    !columns.has("fork_source_checkpoint_turn_count")
  ) {
    yield* sql`
      ALTER TABLE projection_threads
      RENAME COLUMN source_checkpoint_turn_count TO fork_source_checkpoint_turn_count
    `;
  }

  const nextColumns = yield* getProjectionThreadColumns(sql);

  if (!nextColumns.has("fork_source_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_source_thread_id TEXT
    `;
  }

  if (!nextColumns.has("fork_source_turn_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_source_turn_id TEXT
    `;
  }

  if (!nextColumns.has("fork_source_checkpoint_turn_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_source_checkpoint_turn_count INTEGER
    `;
  }

  if (!nextColumns.has("forked_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN forked_at TEXT
    `;
  }
});
