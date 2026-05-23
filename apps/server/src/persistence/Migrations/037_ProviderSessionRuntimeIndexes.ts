import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_last_seen_thread
    ON provider_session_runtime(last_seen_at, thread_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_provider_session_runtime_status_last_seen_thread
    ON provider_session_runtime(status, last_seen_at, thread_id)
  `;
});
