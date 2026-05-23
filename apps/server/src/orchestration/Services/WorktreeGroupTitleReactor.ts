import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface WorktreeGroupTitleReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class WorktreeGroupTitleReactor extends Context.Service<
  WorktreeGroupTitleReactor,
  WorktreeGroupTitleReactorShape
>()("t3/orchestration/Services/WorktreeGroupTitleReactor") {}
