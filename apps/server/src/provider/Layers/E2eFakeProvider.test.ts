import { DEFAULT_MODEL_BY_PROVIDER, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";

import { ProviderUnsupportedError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import {
  E2eFakeProviderAdapterRegistryLive,
  E2eFakeProviderRegistryLive,
  isE2eFakeProviderEnabled,
} from "./E2eFakeProvider.ts";

it("enables the fake provider only for the explicit E2E flag", () => {
  const previous = process.env.T3CODE_E2E_FAKE_PROVIDER;
  try {
    delete process.env.T3CODE_E2E_FAKE_PROVIDER;
    assert.equal(isE2eFakeProviderEnabled(), false);
    process.env.T3CODE_E2E_FAKE_PROVIDER = "true";
    assert.equal(isE2eFakeProviderEnabled(), false);
    process.env.T3CODE_E2E_FAKE_PROVIDER = "1";
    assert.equal(isE2eFakeProviderEnabled(), true);
  } finally {
    if (previous === undefined) {
      delete process.env.T3CODE_E2E_FAKE_PROVIDER;
    } else {
      process.env.T3CODE_E2E_FAKE_PROVIDER = previous;
    }
  }
});

const E2eProviderLayer = Layer.mergeAll(
  E2eFakeProviderAdapterRegistryLive,
  E2eFakeProviderRegistryLive,
);

it.effect("exposes a deterministic authenticated Codex provider snapshot", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry;
    const providers = yield* registry.getProviders;

    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.provider, "codex");
    assert.equal(providers[0]?.enabled, true);
    assert.equal(providers[0]?.installed, true);
    assert.equal(providers[0]?.version, "e2e");
    assert.equal(providers[0]?.auth.status, "authenticated");
    assert.equal(providers[0]?.models[0]?.slug, DEFAULT_MODEL_BY_PROVIDER.codex);
  }).pipe(Effect.provide(E2eProviderLayer)),
);

it.effect("emits a full deterministic session and turn lifecycle", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    const adapter = yield* registry.getByProvider("codex");
    const threadId = ThreadId.make("thread-e2e");
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    const session = yield* adapter.startSession({
      provider: "codex",
      threadId,
      runtimeMode: "full-access",
      cwd: "/repo",
      modelSelection: {
        provider: "codex",
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
      },
    });
    const turn = yield* adapter.sendTurn({
      threadId,
      input: "hello",
      attachments: [],
      modelSelection: {
        provider: "codex",
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
      },
    });
    const events = Array.from(yield* Fiber.join(eventsFiber)) as ProviderRuntimeEvent[];

    assert.equal(session.status, "ready");
    assert.equal(session.cwd, "/repo");
    assert.equal(turn.threadId, threadId);
    assert.deepStrictEqual(
      events.map((event) => event.type),
      ["session.started", "turn.started", "content.delta", "item.completed", "turn.completed"],
    );
    assert.deepStrictEqual(events[2]?.payload, {
      streamKind: "assistant_text",
      delta: "E2E response",
    });

    assert.equal(yield* adapter.hasSession(threadId), true);
    yield* adapter.stopSession(threadId);
    assert.equal(yield* adapter.hasSession(threadId), false);
    yield* adapter.startSession({ provider: "codex", threadId, runtimeMode: "full-access" });
    assert.equal((yield* adapter.listSessions()).length, 1);
    yield* adapter.stopAll();
    assert.equal((yield* adapter.listSessions()).length, 0);
  }).pipe(Effect.provide(E2eProviderLayer)),
);

it.effect("fails unknown provider lookups with ProviderUnsupportedError", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    const result = yield* registry.getByProvider("claudeAgent").pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.deepStrictEqual(
        result.failure,
        new ProviderUnsupportedError({ provider: "claudeAgent" }),
      );
    }
  }).pipe(Effect.provide(E2eProviderLayer)),
);
