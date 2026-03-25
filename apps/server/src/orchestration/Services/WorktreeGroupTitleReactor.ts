import { ServiceMap } from "effect";
import type { Effect, Scope } from "effect";

export interface WorktreeGroupTitleReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class WorktreeGroupTitleReactor extends ServiceMap.Service<
  WorktreeGroupTitleReactor,
  WorktreeGroupTitleReactorShape
>()("t3/orchestration/Services/WorktreeGroupTitleReactor") {}
