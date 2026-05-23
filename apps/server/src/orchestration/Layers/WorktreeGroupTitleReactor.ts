import { randomUUID } from "node:crypto";

import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationThread,
  type OrchestrationWorktreeGroupTitle,
} from "@t3tools/contracts";
import { normalizeWorktreePath } from "@t3tools/shared/worktree";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  WorktreeGroupTitleReactor,
  type WorktreeGroupTitleReactorShape,
} from "../Services/WorktreeGroupTitleReactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const WORKTREE_TITLE_DEBOUNCE = Duration.millis(250);

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
      | "project.worktree-group-title-regeneration-requested";
  }
>;

function serverCommandId(): CommandId {
  return CommandId.make(`server:worktree-group-title:${randomUUID()}`);
}

function titleEventKey(event: TriggerEvent): string {
  if (event.type === "project.worktree-group-title-regeneration-requested") {
    return `worktree:${normalizeWorktreePath(event.payload.worktreePath) ?? event.payload.worktreePath}`;
  }
  return `thread:${event.payload.threadId}`;
}

function titleFromThread(thread: OrchestrationThread): string {
  const messageText = thread.messages
    .filter((message) => message.role !== "system")
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(0)
    ?.text.trim();
  const planText = thread.proposedPlans
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(0)
    ?.planMarkdown.trim();
  const candidate = messageText || planText || thread.title;
  const normalized = candidate.replace(/\s+/g, " ").trim();
  return normalized.length > 60 ? `${normalized.slice(0, 57).trimEnd()}...` : normalized;
}

function nextTitleEntry(input: {
  readonly project: OrchestrationProject;
  readonly worktreePath: string;
  readonly sourceThread: OrchestrationThread | null;
  readonly updatedAt: string;
}): OrchestrationWorktreeGroupTitle | null {
  const normalizedPath = normalizeWorktreePath(input.worktreePath);
  if (!normalizedPath || !input.sourceThread) {
    return null;
  }

  return {
    worktreePath: normalizedPath,
    title: titleFromThread(input.sourceThread),
    status: "ready",
    sourceThreadId: input.sourceThread.id,
    generationId: `deterministic:${input.sourceThread.id}:${input.sourceThread.updatedAt}`,
    updatedAt: input.updatedAt,
  };
}

function newestThreadForWorktree(
  threads: ReadonlyArray<OrchestrationThread>,
  worktreePath: string,
): OrchestrationThread | null {
  const normalizedPath = normalizeWorktreePath(worktreePath);
  return (
    threads
      .filter(
        (thread) =>
          thread.deletedAt === null &&
          normalizeWorktreePath(thread.worktreePath ?? null) === normalizedPath,
      )
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .at(0) ?? null
  );
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const updateProjectWorktreeTitle = Effect.fn("updateProjectWorktreeTitle")(function* (
    event: TriggerEvent,
  ) {
    const snapshot = yield* projectionSnapshotQuery.getSnapshot();
    const sourceThread =
      event.type === "project.worktree-group-title-regeneration-requested"
        ? newestThreadForWorktree(snapshot.threads, event.payload.worktreePath)
        : (snapshot.threads.find((thread) => thread.id === event.payload.threadId) ?? null);
    const projectId = sourceThread?.projectId;
    if (!projectId && event.type !== "project.worktree-group-title-regeneration-requested") {
      return;
    }

    const project = snapshot.projects.find((candidate) => candidate.id === projectId);
    const requestedProject =
      event.type === "project.worktree-group-title-regeneration-requested"
        ? snapshot.projects.find((candidate) => candidate.id === event.payload.projectId)
        : null;
    const targetProject = requestedProject ?? project;
    if (!targetProject) {
      return;
    }

    const worktreePath =
      event.type === "project.worktree-group-title-regeneration-requested"
        ? event.payload.worktreePath
        : sourceThread?.worktreePath;
    const normalizedPath = normalizeWorktreePath(worktreePath ?? null);
    if (!normalizedPath) {
      return;
    }

    if (event.type === "thread.deleted") {
      const remainingTitles = (targetProject.worktreeGroupTitles ?? []).filter(
        (entry) => normalizeWorktreePath(entry.worktreePath) !== normalizedPath,
      );
      if (remainingTitles.length === (targetProject.worktreeGroupTitles ?? []).length) {
        return;
      }
      yield* orchestrationEngine.dispatch({
        type: "project.meta.update",
        commandId: serverCommandId(),
        projectId: targetProject.id,
        worktreeGroupTitles: remainingTitles,
      });
      return;
    }

    const existing = (targetProject.worktreeGroupTitles ?? []).find(
      (entry) => normalizeWorktreePath(entry.worktreePath) === normalizedPath,
    );
    const entry = nextTitleEntry({
      project: targetProject,
      worktreePath: normalizedPath,
      sourceThread,
      updatedAt: yield* nowIso,
    });
    if (
      !entry ||
      (existing?.generationId === entry.generationId && existing.title === entry.title)
    ) {
      return;
    }

    const nextTitles = (targetProject.worktreeGroupTitles ?? [])
      .filter((candidate) => normalizeWorktreePath(candidate.worktreePath) !== normalizedPath)
      .concat([entry])
      .toSorted((left, right) => left.worktreePath.localeCompare(right.worktreePath));

    yield* orchestrationEngine.dispatch({
      type: "project.meta.update",
      commandId: serverCommandId(),
      projectId: targetProject.id,
      worktreeGroupTitles: nextTitles,
    });
  });

  const pendingEvents = new Map<
    string,
    {
      event: TriggerEvent;
      fiber: Fiber.Fiber<void, unknown>;
    }
  >();
  const debounceScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );

  const processTitleEventSafely = (event: TriggerEvent) =>
    updateProjectWorktreeTitle(event).pipe(
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

  const enqueueTitleEvent = (event: TriggerEvent) =>
    Effect.gen(function* () {
      const key = titleEventKey(event);
      const existing = pendingEvents.get(key);
      if (existing) {
        yield* Fiber.interrupt(existing.fiber).pipe(Effect.ignore);
      }

      const delay = event.type === "thread.deleted" ? Duration.zero : WORKTREE_TITLE_DEBOUNCE;
      const fiber = yield* Effect.sleep(delay).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const pending = pendingEvents.get(key);
            if (!pending) return;
            pendingEvents.delete(key);
            yield* processTitleEventSafely(pending.event);
          }),
        ),
        Effect.forkIn(debounceScope),
      );
      pendingEvents.set(key, {
        event,
        fiber,
      });
    });

  const start: WorktreeGroupTitleReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.created" &&
          event.type !== "thread.forked" &&
          event.type !== "thread.meta-updated" &&
          event.type !== "thread.deleted" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.proposed-plan-upserted" &&
          event.type !== "project.worktree-group-title-regeneration-requested"
        ) {
          return Effect.void;
        }
        return enqueueTitleEvent(event);
      }),
    );
  });

  return {
    start,
    drain: Effect.void,
  } satisfies WorktreeGroupTitleReactorShape;
});

export const WorktreeGroupTitleReactorLive = Layer.effect(WorktreeGroupTitleReactor, make);
