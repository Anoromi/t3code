import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as SqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(SqliteClient.layerMemory());

const createMigrationLedgerThrough27 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS idx_auth_pairing_links_active`;
  yield* sql`DROP INDEX IF EXISTS idx_auth_sessions_active`;
  yield* sql`DROP TABLE IF EXISTS auth_pairing_links`;
  yield* sql`DROP TABLE IF EXISTS auth_sessions`;
  yield* sql`DROP TABLE IF EXISTS effect_sql_migrations`;

  yield* sql`
    CREATE TABLE effect_sql_migrations (
      migration_id integer PRIMARY KEY NOT NULL,
      created_at datetime NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;

  for (const [migrationId, name] of migrationEntries) {
    if (migrationId > 27) {
      continue;
    }

    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name)
      VALUES (${migrationId}, ${name})
    `;
  }
});

const getTableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
    ORDER BY name ASC
  `;
  return new Set(rows.map((row) => row.name));
});

const getIndexNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'index'
    ORDER BY name ASC
  `;
  return new Set(rows.map((row) => row.name));
});

const getPairingLinkColumnNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_pairing_links)`;
  return new Set(columns.map((column) => column.name));
});

const getSessionColumnNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  return new Set(columns.map((column) => column.name));
});

layer("028_RepairMissingAuthAccessTables", (it) => {
  it.effect("creates missing auth access tables when prior auth migrations were recorded", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* createMigrationLedgerThrough27;

      const initialTableNames = yield* getTableNames;
      assert.equal(initialTableNames.has("auth_pairing_links"), false);
      assert.equal(initialTableNames.has("auth_sessions"), false);

      yield* runMigrations({ toMigrationInclusive: 28 });

      const tableNames = yield* getTableNames;
      const indexNames = yield* getIndexNames;
      const pairingLinkColumns = yield* getPairingLinkColumnNames;
      const sessionColumns = yield* getSessionColumnNames;
      const repairRows = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM effect_sql_migrations
        WHERE migration_id = 28
      `;

      assert.equal(tableNames.has("auth_pairing_links"), true);
      assert.equal(tableNames.has("auth_sessions"), true);
      assert.equal(indexNames.has("idx_auth_pairing_links_active"), true);
      assert.equal(indexNames.has("idx_auth_sessions_active"), true);
      assert.equal(pairingLinkColumns.has("label"), true);
      assert.equal(sessionColumns.has("client_label"), true);
      assert.equal(sessionColumns.has("client_ip_address"), true);
      assert.equal(sessionColumns.has("client_user_agent"), true);
      assert.equal(sessionColumns.has("client_device_type"), true);
      assert.equal(sessionColumns.has("client_os"), true);
      assert.equal(sessionColumns.has("client_browser"), true);
      assert.equal(sessionColumns.has("last_connected_at"), true);
      assert.deepEqual(repairRows, [{ name: "RepairMissingAuthAccessTables" }]);

      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          method,
          client_label,
          client_ip_address,
          client_user_agent,
          client_device_type,
          client_os,
          client_browser,
          issued_at,
          expires_at,
          revoked_at
        )
        VALUES (
          'session-1',
          'owner',
          'owner',
          'browser-session-cookie',
          'Desktop',
          '127.0.0.1',
          'T3 Code',
          'desktop',
          'Linux',
          NULL,
          '2026-04-18T00:00:00.000Z',
          '2026-04-19T00:00:00.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          role,
          subject,
          label,
          created_at,
          expires_at,
          consumed_at,
          revoked_at
        )
        VALUES (
          'pairing-link-1',
          'credential-1',
          'pairing-link',
          'owner',
          'owner',
          'Desktop',
          '2026-04-18T00:00:00.000Z',
          '2026-04-19T00:00:00.000Z',
          NULL,
          NULL
        )
      `;
    }),
  );

  it.effect("adds current auth columns to partial auth access tables", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* createMigrationLedgerThrough27;

      yield* sql`
        CREATE TABLE auth_pairing_links (
          id TEXT PRIMARY KEY,
          credential TEXT NOT NULL UNIQUE,
          method TEXT NOT NULL,
          role TEXT NOT NULL,
          subject TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          consumed_at TEXT,
          revoked_at TEXT
        )
      `;

      yield* sql`
        CREATE TABLE auth_sessions (
          session_id TEXT PRIMARY KEY,
          subject TEXT NOT NULL,
          role TEXT NOT NULL,
          method TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        )
      `;

      yield* sql`
        INSERT INTO auth_sessions (
          session_id,
          subject,
          role,
          method,
          issued_at,
          expires_at,
          revoked_at
        )
        VALUES (
          'session-1',
          'owner',
          'owner',
          'browser-session-cookie',
          '2026-04-18T00:00:00.000Z',
          '2026-04-19T00:00:00.000Z',
          NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 28 });

      const pairingLinkColumns = yield* getPairingLinkColumnNames;
      const sessionColumns = yield* getSessionColumnNames;
      const sessionRows = yield* sql<{ readonly clientDeviceType: string }>`
        SELECT client_device_type AS "clientDeviceType"
        FROM auth_sessions
        WHERE session_id = 'session-1'
      `;

      assert.equal(pairingLinkColumns.has("label"), true);
      assert.equal(sessionColumns.has("client_label"), true);
      assert.equal(sessionColumns.has("client_ip_address"), true);
      assert.equal(sessionColumns.has("client_user_agent"), true);
      assert.equal(sessionColumns.has("client_device_type"), true);
      assert.equal(sessionColumns.has("client_os"), true);
      assert.equal(sessionColumns.has("client_browser"), true);
      assert.equal(sessionColumns.has("last_connected_at"), true);
      assert.deepEqual(sessionRows, [{ clientDeviceType: "unknown" }]);
    }),
  );
});
