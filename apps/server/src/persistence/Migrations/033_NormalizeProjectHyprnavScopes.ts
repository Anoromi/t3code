import {
  DEFAULT_PROJECT_HYPRNAV_SETTINGS,
  PROJECT_HYPRNAV_CORKDIFF_ID,
  ProjectHyprnavSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeProjectHyprnavSettings = Schema.decodeUnknownSync(ProjectHyprnavSettings);
const DEFAULT_PROJECT_HYPRNAV_JSON = JSON.stringify(DEFAULT_PROJECT_HYPRNAV_SETTINGS);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const rows = yield* sql<{
    readonly projectId: string;
    readonly hyprnavJson: string | null;
  }>`
    SELECT
      project_id AS "projectId",
      hyprnav_json AS "hyprnavJson"
    FROM projection_projects
  `;

  for (const row of rows) {
    const normalizedJson = yield* Effect.try({
      try: () => {
        const rawHyprnavJson = row.hyprnavJson?.trim() ?? "";
        if (rawHyprnavJson.length === 0 || rawHyprnavJson === "null") {
          return "null";
        }
        const decoded = decodeProjectHyprnavSettings(JSON.parse(rawHyprnavJson));
        const normalized = decoded.bindings.some(
          (binding) => binding.id === PROJECT_HYPRNAV_CORKDIFF_ID,
        )
          ? decoded
          : {
              bindings: [
                ...decoded.bindings,
                ...DEFAULT_PROJECT_HYPRNAV_SETTINGS.bindings.filter(
                  (binding) => binding.id === PROJECT_HYPRNAV_CORKDIFF_ID,
                ),
              ],
            };
        return JSON.stringify(normalized) === DEFAULT_PROJECT_HYPRNAV_JSON
          ? "null"
          : JSON.stringify(normalized);
      },
      catch: () => "null",
    });

    yield* sql`
      UPDATE projection_projects
      SET hyprnav_json = ${normalizedJson}
      WHERE project_id = ${row.projectId}
    `;
  }
});
