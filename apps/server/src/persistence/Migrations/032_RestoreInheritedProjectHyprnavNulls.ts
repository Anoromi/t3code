import { DEFAULT_PROJECT_HYPRNAV_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const DEFAULT_PROJECT_HYPRNAV_JSON = JSON.stringify(DEFAULT_PROJECT_HYPRNAV_SETTINGS);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_projects
    SET hyprnav_json = 'null'
    WHERE hyprnav_json IS NULL
       OR trim(hyprnav_json) = ''
       OR trim(hyprnav_json) = 'null'
       OR trim(hyprnav_json) = ${DEFAULT_PROJECT_HYPRNAV_JSON}
  `;
});
