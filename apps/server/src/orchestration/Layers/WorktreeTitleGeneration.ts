import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER } from "@t3tools/contracts";

import { runCodexStructuredOutput } from "../../codexStructuredOutput.ts";
import { WorktreeTitleGenerationError } from "../Errors.ts";
import {
  WorktreeTitleGeneration,
  type WorktreeTitleGenerationShape,
} from "../Services/WorktreeTitleGeneration.ts";

const CODEX_REASONING_EFFORT = "low";
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_TITLE_CHARS = 80;

function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizeGeneratedTitle(raw: string): string {
  const firstLine = raw.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const unwrapped = firstLine.replace(/^["'`]+|["'`]+$/g, "").trim();
  const collapsedWhitespace = unwrapped.replace(/\s+/g, " ").trim();
  return collapsedWhitespace.slice(0, MAX_TITLE_CHARS).trim();
}

const makeWorktreeTitleGeneration = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const generateTitle: WorktreeTitleGenerationShape["generateTitle"] = (input) => {
    const prompt = [
      "You are naming a software workstream from a conversation transcript.",
      "",
      `Source thread title: ${input.sourceThreadTitle}`,
      `Source branch: ${input.sourceBranch ?? ""}`,
      `Source worktree: ${input.worktreePath}`,
      "",
      "Conversation transcript:",
      limitSection(input.transcript, MAX_TRANSCRIPT_CHARS),
      "",
      "If you were to write the title (1 sentence, ~7 words) for this feature how would you do it. Be very sussinct. Forego gramar rules for coherency. This title is meant for users to be able to look at it and in 1 second recognize what they were working on",
      "Respond with title only.",
    ].join("\n");

    return runCodexStructuredOutput({
      operation: "generateWorktreeTitle",
      cwd: input.cwd,
      prompt,
      outputSchema: Schema.Struct({
        title: Schema.String,
      }),
      model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
      reasoningEffort: CODEX_REASONING_EFFORT,
      createError: (detail, cause) =>
        new WorktreeTitleGenerationError({
          operation: "generateWorktreeTitle",
          detail,
          ...(cause !== undefined ? { cause } : {}),
        }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, commandSpawner),
      Effect.provideService(Path.Path, path),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.map((generated) => sanitizeGeneratedTitle(generated.title)),
      Effect.flatMap((title) =>
        title.length > 0
          ? Effect.succeed({ title })
          : Effect.fail(
              new WorktreeTitleGenerationError({
                operation: "generateWorktreeTitle",
                detail: "Codex returned an empty worktree title.",
              }),
            ),
      ),
    );
  };

  return {
    generateTitle,
  } satisfies WorktreeTitleGenerationShape;
});

export const WorktreeTitleGenerationLive = Layer.effect(
  WorktreeTitleGeneration,
  makeWorktreeTitleGeneration,
);
