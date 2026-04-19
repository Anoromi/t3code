import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const tableExists = (sql: SqlClient.SqlClient, tableName: string) =>
  sql<{ readonly exists: number }>`
    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM sqlite_master
        WHERE type = 'table'
          AND name = ${tableName}
      )
      THEN 1
      ELSE 0
    END AS "exists"
  `.pipe(Effect.map((rows) => rows[0]?.exists === 1));

const getProjectionThreadColumns = (sql: SqlClient.SqlClient) =>
  sql`PRAGMA table_info(projection_threads)`.values.pipe(
    Effect.map(
      (rows) => new Set(rows.flatMap((row) => (typeof row[1] === "string" ? [row[1]] : []))),
    ),
  );

const getProjectionTurnColumns = (sql: SqlClient.SqlClient) =>
  sql`PRAGMA table_info(projection_turns)`.values.pipe(
    Effect.map(
      (rows) => new Set(rows.flatMap((row) => (typeof row[1] === "string" ? [row[1]] : []))),
    ),
  );

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const [hasProjectionThreads, hasProjectionTurns] = yield* Effect.all([
    tableExists(sql, "projection_threads"),
    tableExists(sql, "projection_turns"),
  ]);
  if (!hasProjectionThreads || !hasProjectionTurns) {
    return;
  }

  const [threadColumns, turnColumns] = yield* Effect.all([
    getProjectionThreadColumns(sql),
    getProjectionTurnColumns(sql),
  ]);
  if (!threadColumns.has("thread_id") || !threadColumns.has("latest_turn_id")) {
    return;
  }
  if (
    !turnColumns.has("thread_id") ||
    !turnColumns.has("turn_id") ||
    !turnColumns.has("requested_at") ||
    !turnColumns.has("started_at") ||
    !turnColumns.has("completed_at")
  ) {
    return;
  }

  yield* sql`
    UPDATE projection_threads
    SET latest_turn_id = (
      SELECT candidate.turn_id
      FROM projection_turns AS candidate
      WHERE candidate.thread_id = projection_threads.thread_id
        AND candidate.turn_id IS NOT NULL
      ORDER BY
        COALESCE(candidate.completed_at, candidate.started_at, candidate.requested_at) DESC,
        candidate.turn_id DESC
      LIMIT 1
    )
    WHERE (
        projection_threads.latest_turn_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM projection_turns AS existing_turn
          WHERE existing_turn.thread_id = projection_threads.thread_id
            AND existing_turn.turn_id = projection_threads.latest_turn_id
        )
      )
      AND EXISTS (
        SELECT 1
        FROM projection_turns AS candidate
        WHERE candidate.thread_id = projection_threads.thread_id
          AND candidate.turn_id IS NOT NULL
      )
  `;
});
