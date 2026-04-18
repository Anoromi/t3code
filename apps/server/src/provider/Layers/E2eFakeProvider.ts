import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderThreadForkInput,
  type ProviderThreadForkResult,
  type ProviderTurnStartResult,
  type ServerProvider,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";

const PROVIDER = "codex" as const;
const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

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
  threadId: input.threadId,
  createdAt: new Date().toISOString(),
  ...(input.turnId ? { turnId: input.turnId } : {}),
  ...(input.itemId ? { itemId: input.itemId } : {}),
});

function makeFakeProviderSnapshot(): ServerProvider {
  return {
    provider: PROVIDER,
    enabled: true,
    installed: true,
    version: "e2e",
    status: "ready",
    auth: {
      status: "authenticated",
      type: "e2e",
      label: "E2E fake provider",
    },
    checkedAt: new Date().toISOString(),
    models: [
      {
        slug: DEFAULT_MODEL,
        name: "GPT-5.4 E2E",
        isCustom: false,
        capabilities: {
          reasoningEffortLevels: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium", isDefault: true },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High" },
          ],
          supportsFastMode: true,
          supportsThinkingToggle: false,
          contextWindowOptions: [],
          promptInjectedEffortLevels: [],
        },
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
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { e2e: true, threadId: input.threadId },
        cwd: input.cwd ?? process.cwd(),
        model: input.modelSelection?.model ?? DEFAULT_MODEL,
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
          model: input.modelSelection?.model ?? existing?.model ?? DEFAULT_MODEL,
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
    forkThread: (input: ProviderThreadForkInput): Effect.Effect<ProviderThreadForkResult> =>
      Effect.succeed({
        provider: PROVIDER,
        resumeCursor: { e2e: true, forkedFrom: input.sourceThreadId },
        runtimeMode: "full-access",
        runtimePayload: {
          modelSelection: { provider: PROVIDER, model: DEFAULT_MODEL },
        },
      }),
    sendTurn,
    interruptTurn: () => Effect.void,
    respondToRequest: (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ) => Effect.void,
    respondToUserInput: () => Effect.void,
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
    archiveThread: () => Effect.void,
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

export const E2eFakeProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  Effect.gen(function* () {
    const adapter = yield* makeFakeProviderAdapter;
    return {
      getByProvider: (provider) =>
        provider === PROVIDER
          ? Effect.succeed(adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed([PROVIDER]),
    } satisfies ProviderAdapterRegistryShape;
  }),
);

export const E2eFakeProviderRegistryLive = Layer.succeed(ProviderRegistry, {
  getProviders: Effect.succeed([makeFakeProviderSnapshot()]),
  refresh: () => Effect.succeed([makeFakeProviderSnapshot()]),
  streamChanges: Stream.empty,
} satisfies ProviderRegistryShape);
