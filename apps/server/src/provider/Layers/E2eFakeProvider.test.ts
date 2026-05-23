import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderUnsupportedError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderAdapterRegistryLive } from "./ProviderAdapterRegistry.ts";
import {
  E2eFakeProviderInstanceRegistryLive,
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
  E2eFakeProviderInstanceRegistryLive,
  ProviderAdapterRegistryLive.pipe(Layer.provide(E2eFakeProviderInstanceRegistryLive)),
);
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");
const E2E_MODEL = DEFAULT_MODEL_BY_PROVIDER[CODEX_DRIVER] ?? DEFAULT_MODEL;

it.effect("exposes a deterministic authenticated Codex provider snapshot", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    const [instance] = yield* registry.listInstances;
    const providers = instance ? [yield* instance.snapshot.getSnapshot] : [];

    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.driver, "codex");
    assert.equal(providers[0]?.instanceId, CODEX_INSTANCE_ID);
    assert.equal(providers[0]?.enabled, true);
    assert.equal(providers[0]?.installed, true);
    assert.equal(providers[0]?.version, "e2e");
    assert.equal(providers[0]?.auth.status, "authenticated");
    assert.equal(providers[0]?.models[0]?.slug, E2E_MODEL);
  }).pipe(Effect.provide(E2eProviderLayer)),
);

it.effect("emits a full deterministic session and turn lifecycle", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    const adapter = yield* registry.getByInstance(CODEX_INSTANCE_ID);
    const threadId = ThreadId.make("thread-e2e");
    const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    const session = yield* adapter.startSession({
      provider: CODEX_DRIVER,
      threadId,
      runtimeMode: "full-access",
      cwd: "/repo",
      modelSelection: {
        instanceId: CODEX_INSTANCE_ID,
        model: E2E_MODEL,
      },
    });
    const turn = yield* adapter.sendTurn({
      threadId,
      input: "hello",
      attachments: [],
      modelSelection: {
        instanceId: CODEX_INSTANCE_ID,
        model: E2E_MODEL,
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
    yield* adapter.startSession({ provider: CODEX_DRIVER, threadId, runtimeMode: "full-access" });
    assert.equal((yield* adapter.listSessions()).length, 1);
    yield* adapter.stopAll();
    assert.equal((yield* adapter.listSessions()).length, 0);
  }).pipe(Effect.provide(E2eProviderLayer)),
);

it.effect("fails unknown provider lookups with ProviderUnsupportedError", () =>
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry;
    const result = yield* registry
      .getByInstance(ProviderInstanceId.make("claudeAgent"))
      .pipe(Effect.result);

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.deepStrictEqual(
        result.failure,
        new ProviderUnsupportedError({ provider: ProviderDriverKind.make("claudeAgent") }),
      );
    }
  }).pipe(Effect.provide(E2eProviderLayer)),
);
