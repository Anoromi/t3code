import type { DesktopControlEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface DesktopControlShape {
  readonly publish: (event: DesktopControlEvent) => Effect.Effect<void>;
  readonly subscribe: Effect.Effect<PubSub.Subscription<DesktopControlEvent>, never, Scope.Scope>;
  readonly stream: Stream.Stream<DesktopControlEvent>;
}

export class DesktopControl extends Context.Service<DesktopControl, DesktopControlShape>()(
  "t3/desktopControl",
) {}

export const DesktopControlLive = Layer.effect(
  DesktopControl,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<DesktopControlEvent>();
    return {
      publish: (event) => PubSub.publish(pubsub, event).pipe(Effect.asVoid),
      subscribe: PubSub.subscribe(pubsub),
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies DesktopControlShape;
  }),
);
