import { Context } from "effect";
import type { Effect } from "effect";

import type { WorktreeTitleGenerationError } from "../Errors.ts";

export interface WorktreeTitleGenerationInput {
  cwd: string;
  worktreePath: string;
  sourceThreadTitle: string;
  sourceBranch: string | null;
  transcript: string;
}

export interface WorktreeTitleGenerationResult {
  title: string;
}

export interface WorktreeTitleGenerationShape {
  readonly generateTitle: (
    input: WorktreeTitleGenerationInput,
  ) => Effect.Effect<WorktreeTitleGenerationResult, WorktreeTitleGenerationError>;
}

export class WorktreeTitleGeneration extends Context.Service<
  WorktreeTitleGeneration,
  WorktreeTitleGenerationShape
>()("t3/orchestration/Services/WorktreeTitleGeneration") {}
