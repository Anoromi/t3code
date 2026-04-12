import { Effect, Fiber, Stream } from "effect";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { DesktopControl, DesktopControlLive } from "./desktopControl";

describe("DesktopControl", () => {
  it("publishes desktop control events to subscribers", async () => {
    const events = await Effect.scoped(
      Effect.gen(function* () {
        const desktopControl = yield* DesktopControl;
        const fiber = yield* Effect.forkScoped(
          Stream.runCollect(Stream.take(desktopControl.stream, 1)),
        );
        yield* Effect.sleep("1 millis");
        yield* desktopControl.publish({
          type: "corkdiff.focusAppRequested",
          threadId: ThreadId.makeUnsafe("thread-1"),
        });
        return yield* Fiber.join(fiber).pipe(Effect.map((chunk) => [...chunk]));
      }),
    ).pipe(Effect.provide(DesktopControlLive), Effect.runPromise);

    expect(events).toEqual([
      {
        type: "corkdiff.focusAppRequested",
        threadId: "thread-1",
      },
    ]);
  });
});
