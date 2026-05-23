import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { describe, expect } from "vitest";

import { DesktopControl, DesktopControlLive } from "./desktopControl.ts";

describe("DesktopControl", () => {
  it.effect("publishes Corkdiff focus requests to subscribers", () =>
    Effect.gen(function* () {
      const desktopControl = yield* DesktopControl;
      const subscription = yield* desktopControl.subscribe;

      yield* desktopControl.publish({
        type: "corkdiff.focusAppRequested",
        threadId: ThreadId.make("thread-1"),
      });

      const event = yield* PubSub.take(subscription);
      expect(event).toEqual({
        type: "corkdiff.focusAppRequested",
        threadId: "thread-1",
      });
    }).pipe(Effect.provide(DesktopControlLive)),
  );
});
