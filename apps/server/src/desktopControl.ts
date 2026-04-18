import type { DesktopControlEvent } from "@t3tools/contracts";
import { Context, Effect, Layer, PubSub, Stream } from "effect";

export interface DesktopControlShape {
  readonly publish: (event: DesktopControlEvent) => Effect.Effect<void>;
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
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies DesktopControlShape;
  }),
);
