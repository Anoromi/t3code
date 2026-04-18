import { Effect, Fiber, Stream } from "effect";
import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { DesktopControl, DesktopControlLive } from "./desktopControl.js";

describe("DesktopControl", () => {
  it("publishes desktop control events to subscribers", async () => {
    const events = await Effect.runPromise(
      Effect.provide(
        Effect.scoped(
          Effect.gen(function* () {
            const desktopControl = yield* DesktopControl;
            const fiber = yield* Effect.forkScoped(
              Stream.runCollect(Stream.take(desktopControl.stream, 1)),
            );
            yield* Effect.sleep("1 millis");
            yield* desktopControl.publish({
              type: "corkdiff.focusAppRequested",
              threadId: ThreadId.make("thread-1"),
            });
            return yield* Fiber.join(fiber).pipe(Effect.map((chunk) => [...chunk]));
          }),
        ),
        DesktopControlLive,
      ),
    );

    expect(events).toEqual([
      {
        type: "corkdiff.focusAppRequested",
        threadId: "thread-1",
      },
    ]);
  });
});
