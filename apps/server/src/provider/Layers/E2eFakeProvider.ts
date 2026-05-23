// @effect-diagnostics globalDate:off globalDateInEffect:off
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  TextGenerationError,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { type ProviderAdapterError } from "../Errors.ts";
import { defaultProviderContinuationIdentity, type ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";

const PROVIDER = ProviderDriverKind.make("codex");
const INSTANCE_ID = defaultInstanceIdForDriver(PROVIDER);
const E2E_MODEL = DEFAULT_MODEL_BY_PROVIDER[PROVIDER] ?? DEFAULT_MODEL;

export function isE2eFakeProviderEnabled(): boolean {
  return process.env.T3CODE_E2E_FAKE_PROVIDER === "1";
}

const nextId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

const makeEventBase = (input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: RuntimeItemId;
}) => ({
  eventId: EventId.make(nextId("e2e-event")),
  provider: PROVIDER,
  providerInstanceId: INSTANCE_ID,
  threadId: input.threadId,
  createdAt: new Date().toISOString(),
  ...(input.turnId ? { turnId: input.turnId } : {}),
  ...(input.itemId ? { itemId: input.itemId } : {}),
});

function makeFakeProviderSnapshot(): ServerProvider {
  return {
    instanceId: INSTANCE_ID,
    driver: PROVIDER,
    continuation: {
      groupKey: `${PROVIDER}:instance:${INSTANCE_ID}`,
    },
    enabled: true,
    installed: true,
    version: "e2e",
    status: "ready",
    availability: "available",
    auth: {
      status: "authenticated",
      type: "e2e",
      label: "E2E fake provider",
    },
    checkedAt: new Date().toISOString(),
    models: [
      {
        slug: E2E_MODEL,
        name: "GPT-5.4 E2E",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

const publish = (pubSub: PubSub.PubSub<ProviderRuntimeEvent>, event: ProviderRuntimeEvent) =>
  PubSub.publish(pubSub, event).pipe(Effect.asVoid);

const makeFakeProviderAdapter = Effect.gen(function* () {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const startSession = (
    input: ProviderSessionStartInput,
  ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: input.providerInstanceId ?? INSTANCE_ID,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { e2e: true, threadId: input.threadId },
        cwd: input.cwd ?? process.cwd(),
        model: input.modelSelection?.model ?? E2E_MODEL,
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(input.threadId, session);
      yield* publish(runtimeEventPubSub, {
        ...makeEventBase({ threadId: input.threadId }),
        type: "session.started",
        payload: { message: "E2E fake provider session started", resume: session.resumeCursor },
      });
      return session;
    });

  const sendTurn = (
    input: ProviderSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const existing = sessions.get(input.threadId);
      const turnId = TurnId.make(nextId("e2e-turn"));
      const assistantItemId = RuntimeItemId.make(nextId("e2e-assistant"));
      if (existing) {
        sessions.set(input.threadId, {
          ...existing,
          status: "running",
          activeTurnId: turnId,
          updatedAt: now,
        });
      }

      yield* publish(runtimeEventPubSub, {
        ...makeEventBase({ threadId: input.threadId, turnId }),
        type: "turn.started",
        payload: {
          model: input.modelSelection?.model ?? existing?.model ?? E2E_MODEL,
        },
      });
      yield* publish(runtimeEventPubSub, {
        ...makeEventBase({ threadId: input.threadId, turnId, itemId: assistantItemId }),
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: "E2E response",
        },
      });
      yield* publish(runtimeEventPubSub, {
        ...makeEventBase({ threadId: input.threadId, turnId, itemId: assistantItemId }),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
        },
      });
      yield* publish(runtimeEventPubSub, {
        ...makeEventBase({ threadId: input.threadId, turnId }),
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: "e2e",
        },
      });

      const latest = sessions.get(input.threadId);
      if (latest) {
        sessions.set(input.threadId, {
          ...latest,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: new Date().toISOString(),
        });
      }

      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: { e2e: true, turnId },
      };
    });

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn: () => Effect.void,
    respondToRequest: (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ) => Effect.void,
    respondToUserInput: (
      _threadId: ThreadId,
      _requestId: string,
      _answers: ProviderUserInputAnswers,
    ) => Effect.void,
    stopSession: (threadId: ThreadId) =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => Array.from(sessions.values())),
    hasSession: (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId: ThreadId) =>
      Effect.succeed({
        threadId,
        turns: [],
      }),
    rollbackThread: (threadId: ThreadId) =>
      Effect.succeed({
        threadId,
        turns: [],
      }),
    stopAll: () =>
      Effect.sync(() => {
        sessions.clear();
      }),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  return adapter;
});

const textGeneration: TextGenerationShape = {
  generateCommitMessage: () =>
    Effect.fail(
      new TextGenerationError({ operation: "generateCommitMessage", detail: "E2E fake provider" }),
    ),
  generatePrContent: () =>
    Effect.fail(
      new TextGenerationError({ operation: "generatePrContent", detail: "E2E fake provider" }),
    ),
  generateBranchName: () => Effect.succeed({ branch: "e2e-branch" }),
  generateThreadTitle: () => Effect.succeed({ title: "E2E Thread" }),
};

export const E2eFakeProviderInstanceRegistryLive = Layer.effect(
  ProviderInstanceRegistry,
  Effect.gen(function* () {
    const adapter = yield* makeFakeProviderAdapter;
    const changes = yield* PubSub.unbounded<void>();
    const instance: ProviderInstance = {
      instanceId: INSTANCE_ID,
      driverKind: PROVIDER,
      continuationIdentity: defaultProviderContinuationIdentity({
        driverKind: PROVIDER,
        instanceId: INSTANCE_ID,
      }),
      displayName: undefined,
      enabled: true,
      snapshot: {
        maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
          provider: PROVIDER,
          packageName: null,
        }),
        getSnapshot: Effect.succeed(makeFakeProviderSnapshot()),
        refresh: Effect.succeed(makeFakeProviderSnapshot()),
        streamChanges: Stream.empty,
      },
      adapter,
      textGeneration,
    };

    return {
      getInstance: (instanceId: ProviderInstanceId) =>
        Effect.succeed(instanceId === INSTANCE_ID ? instance : undefined),
      listInstances: Effect.succeed([instance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.fromPubSub(changes),
      subscribeChanges: PubSub.subscribe(changes),
    };
  }),
);
