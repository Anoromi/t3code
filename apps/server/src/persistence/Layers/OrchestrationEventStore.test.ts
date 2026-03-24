import { CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError } from "../Errors.ts";
import { OrchestrationEventStore } from "../Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("OrchestrationEventStore", (it) => {
  it.effect("stores json columns as strings and replays decoded events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "project.created",
        eventId: EventId.makeUnsafe("evt-store-roundtrip"),
        aggregateKind: "project",
        aggregateId: ProjectId.makeUnsafe("project-roundtrip"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-store-roundtrip"),
        metadata: {
          adapterKey: "codex",
        },
        payload: {
          projectId: ProjectId.makeUnsafe("project-roundtrip"),
          title: "Roundtrip Project",
          workspaceRoot: "/tmp/project-roundtrip",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const storedRows = yield* sql<{
        readonly payloadJson: string;
        readonly metadataJson: string;
      }>`
        SELECT
          payload_json AS "payloadJson",
          metadata_json AS "metadataJson"
        FROM orchestration_events
        WHERE event_id = ${appended.eventId}
      `;
      assert.equal(storedRows.length, 1);
      assert.equal(typeof storedRows[0]?.payloadJson, "string");
      assert.equal(typeof storedRows[0]?.metadataJson, "string");

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0]?.type, "project.created");
      assert.equal(replayed[0]?.metadata.adapterKey, "codex");
    }),
  );

  it.effect("replays legacy project.created rows without defaultModelSelection", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-legacy-project-created")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-legacy-project-created")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-legacy-project-created")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            projectId: "project-legacy-project-created",
            title: "Legacy Project",
            workspaceRoot: "/tmp/project-legacy-project-created",
            scripts: [],
            createdAt: now,
            updatedAt: now,
          })},
          ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 10)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );

      const legacyEvent = replayed.find(
        (event) => event.aggregateId === ProjectId.makeUnsafe("project-legacy-project-created"),
      );
      assert.ok(legacyEvent);
      assert.equal(legacyEvent.type, "project.created");
      if (legacyEvent.type === "project.created") {
        assert.equal(legacyEvent.payload.defaultModelSelection, null);
      }
    }),
  );

  it.effect("replays legacy thread.created rows with a plain model field", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-legacy-thread-created")},
          ${"thread"},
          ${ThreadId.makeUnsafe("thread-legacy-thread-created")},
          ${0},
          ${"thread.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-legacy-thread-created")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            threadId: "thread-legacy-thread-created",
            projectId: "project-legacy-project-created",
            title: "Legacy Thread",
            model: "gpt-5",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          })},
          ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 20)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );

      const legacyEvent = replayed.find(
        (event) => event.aggregateId === ThreadId.makeUnsafe("thread-legacy-thread-created"),
      );
      assert.ok(legacyEvent);
      assert.equal(legacyEvent.type, "thread.created");
      if (legacyEvent.type === "thread.created") {
        assert.deepStrictEqual(legacyEvent.payload.modelSelection, {
          provider: "codex",
          model: "gpt-5",
        });
      }
    }),
  );

  it.effect("replays legacy thread.forked rows as thread.created events", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-legacy-thread-forked")},
          ${"thread"},
          ${ThreadId.makeUnsafe("thread-legacy-thread-forked")},
          ${0},
          ${"thread.forked"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-legacy-thread-forked")},
          ${null},
          ${null},
          ${"server"},
          ${JSON.stringify({
            threadId: "thread-legacy-thread-forked",
            projectId: "project-legacy-project-created",
            title: "Legacy Forked Thread",
            model: "gpt-5.4",
            forkOrigin: {
              sourceThreadId: "thread-source",
              sourceTurnId: "turn-source",
              sourceCheckpointTurnCount: 3,
              forkedAt: now,
            },
            latestTurn: {
              turnId: "turn-source",
              state: "completed",
              requestedAt: now,
              startedAt: now,
              completedAt: now,
              assistantMessageId: "message-source",
            },
            messages: [],
            activities: [],
            checkpoints: [],
            turns: [],
            createdAt: now,
            updatedAt: now,
          })},
          ${"{}"}
        )
      `;

      const replayed = yield* Stream.runCollect(eventStore.readFromSequence(0, 20)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );

      const legacyEvent = replayed.find(
        (event) => event.aggregateId === ThreadId.makeUnsafe("thread-legacy-thread-forked"),
      );
      assert.ok(legacyEvent);
      assert.equal(legacyEvent.type, "thread.created");
      if (legacyEvent.type === "thread.created") {
        assert.deepStrictEqual(legacyEvent.payload.modelSelection, {
          provider: "codex",
          model: "gpt-5.4",
        });
        assert.equal(legacyEvent.payload.runtimeMode, "full-access");
        assert.equal(legacyEvent.payload.interactionMode, "default");
      }
    }),
  );

  it.effect("fails with PersistenceDecodeError when stored json is invalid", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = new Date().toISOString();

      yield* sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${EventId.makeUnsafe("evt-store-invalid-json")},
          ${"project"},
          ${ProjectId.makeUnsafe("project-invalid-json")},
          ${0},
          ${"project.created"},
          ${now},
          ${CommandId.makeUnsafe("cmd-store-invalid-json")},
          ${null},
          ${null},
          ${"server"},
          ${"{"},
          ${"{}"}
        )
      `;

      const replayResult = yield* Effect.result(
        Stream.runCollect(eventStore.readFromSequence(0, 10)),
      );
      assert.equal(replayResult._tag, "Failure");
      if (replayResult._tag === "Failure") {
        assert.ok(Schema.is(PersistenceDecodeError)(replayResult.failure));
        assert.ok(
          replayResult.failure.operation.includes(
            "OrchestrationEventStore.readFromSequence:decodeRows",
          ),
        );
      }
    }),
  );

  it.effect("round-trips thread.forked events without checkpoint ancestry", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const now = new Date().toISOString();

      const appended = yield* eventStore.append({
        type: "thread.forked",
        eventId: EventId.makeUnsafe("evt-thread-forked-roundtrip"),
        aggregateKind: "thread",
        aggregateId: ThreadId.makeUnsafe("thread-forked-roundtrip"),
        occurredAt: now,
        commandId: CommandId.makeUnsafe("cmd-thread-forked-roundtrip"),
        causationEventId: null,
        correlationId: CommandId.makeUnsafe("cmd-thread-forked-roundtrip"),
        metadata: {},
        payload: {
          threadId: ThreadId.makeUnsafe("thread-forked-roundtrip"),
          projectId: ProjectId.makeUnsafe("project-roundtrip"),
          title: "Fork: Roundtrip",
          model: "gpt-5",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          forkOrigin: {
            sourceThreadId: ThreadId.makeUnsafe("thread-source-roundtrip"),
            sourceTurnId: null,
            sourceCheckpointTurnCount: null,
            forkedAt: now,
          },
          latestTurn: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          turns: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      const replayed = yield* Stream.runCollect(
        eventStore.readFromSequence(appended.sequence - 1, 10),
      ).pipe(Effect.map((chunk) => Array.from(chunk)));
      const forkedEvent = replayed.find((event) => event.eventId === appended.eventId);
      assert.equal(forkedEvent?.type, "thread.forked");
      if (forkedEvent?.type === "thread.forked") {
        assert.equal(forkedEvent.payload.forkOrigin.sourceTurnId, null);
        assert.equal(forkedEvent.payload.forkOrigin.sourceCheckpointTurnCount, null);
      }
    }),
  );
});
