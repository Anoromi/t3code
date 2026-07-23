import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { repairProjectionThreadLatestTurnIds } from "../Repairs/ProjectionThreadLatestTurnIds.ts";

const canonicalMigrationNames = new Map<number, string>([
  [16, "CanonicalizeModelSelections"],
  [17, "ProjectionThreadsArchivedAt"],
  [18, "ProjectionThreadsArchivedAtIndex"],
  [19, "ProjectionSnapshotLookupIndexes"],
  [20, "AuthAccessManagement"],
  [21, "AuthSessionClientMetadata"],
  [22, "AuthSessionLastConnectedAt"],
  [23, "ProjectionThreadShellSummary"],
  [24, "BackfillProjectionThreadShellSummary"],
  [25, "CleanupInvalidProjectionPendingApprovals"],
  [26, "CanonicalizeModelSelectionOptions"],
  [27, "ProviderSessionRuntimeInstanceId"],
  [28, "ProjectionThreadSessionInstanceId"],
  [29, "ProjectionThreadDetailOrderingIndexes"],
  [30, "ProjectionThreadShellArchiveIndexes"],
  [31, "AuthAuthorizationScopes"],
  [32, "AuthPairingProofKeyThumbprint"],
  [33, "ProjectionThreadsSettled"],
]);

export const hasForkMigrationLedger = Effect.fn("hasForkMigrationLedger")(function* (
  sql: SqlClient.SqlClient,
) {
  const rows = yield* sql<{ readonly migrationId: number; readonly name: string }>`
    SELECT migration_id AS "migrationId", name
    FROM effect_sql_migrations
    WHERE migration_id BETWEEN 16 AND 33
  `;
  return rows.some((row) => canonicalMigrationNames.get(row.migrationId) !== row.name);
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* repairProjectionThreadLatestTurnIds(sql, {
    backfillMissing: yield* hasForkMigrationLedger(sql),
  });
});
