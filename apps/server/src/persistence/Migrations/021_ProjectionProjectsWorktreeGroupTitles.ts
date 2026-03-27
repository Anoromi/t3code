import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN worktree_group_titles_json TEXT NOT NULL DEFAULT '[]'
  `.pipe(Effect.catch(() => Effect.void));

  yield* sql`
    UPDATE projection_projects
    SET worktree_group_titles_json = '[]'
    WHERE worktree_group_titles_json IS NULL OR trim(worktree_group_titles_json) = ''
  `;
});
