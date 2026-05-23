import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("037_ProviderSessionRuntimeIndexes", (it) => {
  it.effect("creates provider runtime ordering indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* runMigrations({ toMigrationInclusive: 37 });

      const indexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(provider_session_runtime)
      `;

      assert.ok(
        indexes.some((index) => index.name === "idx_provider_session_runtime_last_seen_thread"),
      );
      assert.ok(
        indexes.some(
          (index) => index.name === "idx_provider_session_runtime_status_last_seen_thread",
        ),
      );
    }),
  );
});
