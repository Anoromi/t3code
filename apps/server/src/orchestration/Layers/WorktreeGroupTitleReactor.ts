import { randomUUID } from "node:crypto";

import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Ref, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { normalizeWorktreePath } from "@t3tools/shared/worktree";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  WorktreeGroupTitleReactor,
  type WorktreeGroupTitleReactorShape,
} from "../Services/WorktreeGroupTitleReactor.ts";
import { WorktreeTitleGeneration } from "../Services/WorktreeTitleGeneration.ts";

type TriggerEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.created"
      | "thread.forked"
      | "thread.meta-updated"
      | "thread.deleted"
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.reverted"
      | "project.worktree-group-title-regeneration-requested";
  }
>;

function serverCommandId(tag: string): CommandId {
  return CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);
}

function compareThreadCreatedAsc(
  left: Pick<OrchestrationThread, "createdAt" | "id">,
  right: Pick<OrchestrationThread, "createdAt" | "id">,
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) || String(left.id).localeCompare(String(right.id))
  );
}

function hasUsableTitleContext(
  thread: Pick<OrchestrationThread, "messages" | "proposedPlans">,
): boolean {
  return (
    thread.messages.some(
      (message) => message.role !== "system" && message.text.trim().length > 0,
    ) || thread.proposedPlans.some((plan) => plan.planMarkdown.trim().length > 0)
  );
}

function serializeThreadTranscript(
  thread: Pick<OrchestrationThread, "messages" | "proposedPlans">,
): string {
  const messageLines = thread.messages
    .filter((message) => message.role !== "system" && message.text.trim().length > 0)
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .map(
      (message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${message.text.trim()}`,
    );

  const proposedPlanBlocks = thread.proposedPlans
    .filter((plan) => plan.planMarkdown.trim().length > 0)
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .map((plan) => `Plan:\n${plan.planMarkdown.trim()}`);

  return [...messageLines, ...proposedPlanBlocks].join("\n\n");
}

function waitForZeroActiveGenerations(activeGenerationCount: Ref.Ref<number>): Effect.Effect<void> {
  return Ref.get(activeGenerationCount).pipe(
    Effect.flatMap((count) =>
      count === 0
        ? Effect.void
        : Effect.sleep("10 millis").pipe(
            Effect.flatMap(() => waitForZeroActiveGenerations(activeGenerationCount)),
          ),
    ),
  );
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const worktreeTitleGeneration = yield* WorktreeTitleGeneration;
  const activeGenerationIdsByKey = yield* Ref.make(new Map<string, string>());
  const activeGenerationCount = yield* Ref.make(0);

  const getProject = (projectId: ProjectId) =>
    orchestrationEngine
      .getReadModel()
      .pipe(
        Effect.map(
          (readModel) => readModel.projects.find((project) => project.id === projectId) ?? null,
        ),
      );

  const upsertProjectWorktreeGroupTitle = Effect.fnUntraced(function* (input: {
    readonly projectId: ProjectId;
    readonly worktreePath: string;
    readonly entry: {
      readonly worktreePath: string;
      readonly title: string | null;
      readonly status: "pending" | "ready" | "failed";
      readonly sourceThreadId: ThreadId | null;
      readonly generationId: string;
      readonly updatedAt: string;
    };
  }) {
    const project = yield* getProject(input.projectId);
    if (!project) {
      return;
    }

    const normalizedPath = normalizeWorktreePath(input.worktreePath);
    if (!normalizedPath) {
      return;
    }

    const nextTitles = (project.worktreeGroupTitles ?? [])
      .filter((entry) => normalizeWorktreePath(entry.worktreePath) !== normalizedPath)
      .concat([input.entry])
      .toSorted((left, right) => left.worktreePath.localeCompare(right.worktreePath));

    yield* orchestrationEngine.dispatch({
      type: "project.meta.update",
      commandId: serverCommandId("worktree-group-title-update"),
      projectId: project.id,
      worktreeGroupTitles: nextTitles,
    });
  });

  const maybePersistCompletion = Effect.fnUntraced(function* (input: {
    readonly projectId: ProjectId;
    readonly worktreePath: string;
    readonly generationId: string;
    readonly sourceThreadId: ThreadId | null;
    readonly result:
      | { readonly status: "ready"; readonly title: string }
      | { readonly status: "failed"; readonly title: null };
  }) {
    const normalizedPath = normalizeWorktreePath(input.worktreePath);
    if (!normalizedPath) {
      return;
    }

    const project = yield* getProject(input.projectId);
    if (!project) {
      return;
    }

    const currentEntry =
      (project.worktreeGroupTitles ?? []).find(
        (entry) => normalizeWorktreePath(entry.worktreePath) === normalizedPath,
      ) ?? null;
    if (!currentEntry || currentEntry.generationId !== input.generationId) {
      return;
    }

    yield* upsertProjectWorktreeGroupTitle({
      projectId: input.projectId,
      worktreePath: normalizedPath,
      entry: {
        worktreePath: normalizedPath,
        title: input.result.title,
        status: input.result.status,
        sourceThreadId: input.sourceThreadId,
        generationId: input.generationId,
        updatedAt: new Date().toISOString(),
      },
    });
  });

  const spawnGeneration = Effect.fnUntraced(function* (input: {
    readonly projectId: ProjectId;
    readonly worktreePath: string;
    readonly sourceThread: OrchestrationThread;
  }) {
    const normalizedPath = normalizeWorktreePath(input.worktreePath);
    if (!normalizedPath) {
      return;
    }

    const generationId = randomUUID();
    const activeKey = `${input.projectId}::${normalizedPath}`;
    const transcript = serializeThreadTranscript(input.sourceThread);
    if (transcript.trim().length === 0) {
      return;
    }

    yield* Ref.update(activeGenerationIdsByKey, (current) => {
      const next = new Map(current);
      next.set(activeKey, generationId);
      return next;
    });
    yield* Ref.update(activeGenerationCount, (count) => count + 1);

    const run = Effect.gen(function* () {
      yield* upsertProjectWorktreeGroupTitle({
        projectId: input.projectId,
        worktreePath: normalizedPath,
        entry: {
          worktreePath: normalizedPath,
          title: null,
          status: "pending",
          sourceThreadId: input.sourceThread.id,
          generationId,
          updatedAt: new Date().toISOString(),
        },
      });

      const generated = yield* worktreeTitleGeneration.generateTitle({
        cwd: normalizedPath,
        worktreePath: normalizedPath,
        sourceThreadTitle: input.sourceThread.title,
        sourceBranch: input.sourceThread.branch,
        transcript,
      });

      yield* maybePersistCompletion({
        projectId: input.projectId,
        worktreePath: normalizedPath,
        generationId,
        sourceThreadId: input.sourceThread.id,
        result: {
          status: "ready",
          title: generated.title,
        },
      });
    }).pipe(
      Effect.catch((error) =>
        maybePersistCompletion({
          projectId: input.projectId,
          worktreePath: normalizedPath,
          generationId,
          sourceThreadId: input.sourceThread.id,
          result: {
            status: "failed",
            title: null,
          },
        }).pipe(
          Effect.flatMap(() =>
            Effect.logWarning("worktree group title generation failed", {
              projectId: input.projectId,
              worktreePath: normalizedPath,
              sourceThreadId: input.sourceThread.id,
              reason: error instanceof Error ? error.message : String(error),
            }),
          ),
        ),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Ref.update(activeGenerationIdsByKey, (current) => {
            const next = new Map(current);
            if (next.get(activeKey) === generationId) {
              next.delete(activeKey);
            }
            return next;
          });
          yield* Ref.update(activeGenerationCount, (count) => Math.max(0, count - 1));
        }),
      ),
    );

    yield* Effect.forkScoped(run);
  });

  const enqueueAutomaticGenerationsForProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const project = readModel.projects.find((entry) => entry.id === projectId);
    if (!project) {
      return;
    }

    const threads = readModel.threads.filter(
      (thread) => thread.projectId === projectId && thread.deletedAt === null,
    );
    const groupedThreadsByPath = new Map<string, OrchestrationThread[]>();
    for (const thread of threads) {
      const normalizedPath = normalizeWorktreePath(thread.worktreePath);
      if (!normalizedPath) {
        continue;
      }
      const existing = groupedThreadsByPath.get(normalizedPath);
      if (existing) {
        existing.push(thread);
      } else {
        groupedThreadsByPath.set(normalizedPath, [thread]);
      }
    }

    const activeGenerations = yield* Ref.get(activeGenerationIdsByKey);
    for (const [worktreePath, worktreeThreads] of groupedThreadsByPath) {
      if (worktreeThreads.length <= 1) {
        continue;
      }

      const existingEntry =
        (project.worktreeGroupTitles ?? []).find(
          (entry) => normalizeWorktreePath(entry.worktreePath) === worktreePath,
        ) ?? null;
      if (existingEntry) {
        continue;
      }

      const activeKey = `${projectId}::${worktreePath}`;
      if (activeGenerations.has(activeKey)) {
        continue;
      }

      const sourceThread =
        [...worktreeThreads].toSorted(compareThreadCreatedAsc).find(hasUsableTitleContext) ?? null;
      if (!sourceThread) {
        continue;
      }

      yield* spawnGeneration({
        projectId,
        worktreePath,
        sourceThread,
      });
    }
  });

  const handleRegenerationRequest = Effect.fnUntraced(function* (
    event: Extract<TriggerEvent, { type: "project.worktree-group-title-regeneration-requested" }>,
  ) {
    const normalizedPath = normalizeWorktreePath(event.payload.worktreePath);
    if (!normalizedPath) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const groupedThreads = readModel.threads
      .filter(
        (thread) =>
          thread.projectId === event.payload.projectId &&
          thread.deletedAt === null &&
          normalizeWorktreePath(thread.worktreePath) === normalizedPath,
      )
      .toSorted(compareThreadCreatedAsc);
    if (groupedThreads.length <= 1) {
      return;
    }

    const sourceThread = groupedThreads.find(hasUsableTitleContext) ?? null;
    if (!sourceThread) {
      return;
    }

    yield* spawnGeneration({
      projectId: event.payload.projectId,
      worktreePath: normalizedPath,
      sourceThread,
    });
  });

  const processDomainEvent = (event: TriggerEvent) =>
    Effect.gen(function* () {
      if (event.type === "project.worktree-group-title-regeneration-requested") {
        yield* handleRegenerationRequest(event);
        return;
      }

      const thread = (yield* orchestrationEngine.getReadModel()).threads.find(
        (entry) => entry.id === event.aggregateId || entry.id === event.payload.threadId,
      );
      if (!thread) {
        return;
      }

      yield* enqueueAutomaticGenerationsForProject(thread.projectId);
    });

  const processDomainEventSafely = (event: TriggerEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("worktree group title reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: WorktreeGroupTitleReactorShape["start"] = Effect.gen(function* () {
    const initialReadModel = yield* orchestrationEngine.getReadModel();
    for (const project of initialReadModel.projects) {
      yield* enqueueAutomaticGenerationsForProject(project.id);
    }

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.created" &&
          event.type !== "thread.forked" &&
          event.type !== "thread.meta-updated" &&
          event.type !== "thread.deleted" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.proposed-plan-upserted" &&
          event.type !== "thread.reverted" &&
          event.type !== "project.worktree-group-title-regeneration-requested"
        ) {
          return Effect.void;
        }

        return worker.enqueue(event);
      }),
    );
  }).pipe(Effect.asVoid);

  const drain: WorktreeGroupTitleReactorShape["drain"] = worker.drain.pipe(
    Effect.flatMap(() => waitForZeroActiveGenerations(activeGenerationCount)),
  );

  return {
    start,
    drain,
  } satisfies WorktreeGroupTitleReactorShape;
});

export const WorktreeGroupTitleReactorLive = Layer.effect(WorktreeGroupTitleReactor, make);
