import type {
  MessageId,
  OrchestrationEvent,
  OrchestrationLatestTurn,
  OrchestrationProposedPlanId,
  ThreadForkCommand,
  ThreadId,
} from "@t3tools/contracts";
import {
  OrchestrationProposedPlanId as OrchestrationProposedPlanIdSchema,
  EventId as EventIdSchema,
  MessageId as MessageIdSchema,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { requireThread, requireThreadAbsent } from "../commandInvariants.ts";
import { ThreadForkService, type ThreadForkServiceShape } from "../Services/ThreadForkService.ts";

function truncateThreadTitle(text: string, maxLength = 50): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

function projectionTurnStateToLatestTurnState(
  state: "pending" | "running" | "completed" | "interrupted" | "error",
) {
  if (state === "pending") return "running" as const;
  if (state === "running") return "running" as const;
  if (state === "interrupted") return "interrupted" as const;
  if (state === "error") return "error" as const;
  return "completed" as const;
}

function payloadAsRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : null;
}

function extractActivityRequestId(payload: unknown): string | null {
  const record = payloadAsRecord(payload);
  return typeof record?.requestId === "string" ? record.requestId : null;
}

function extractActivityFailureDetail(payload: unknown): string | undefined {
  const record = payloadAsRecord(payload);
  return typeof record?.detail === "string" ? record.detail : undefined;
}

function isStalePendingRequestFailure(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request")
  );
}

function filterOpenInteractiveActivities<
  TActivity extends {
    readonly kind: string;
    readonly payload: unknown;
  },
>(activities: ReadonlyArray<TActivity>): Array<TActivity> {
  const openApprovalRequestIds = new Set<string>();
  const openUserInputRequestIds = new Set<string>();

  for (const activity of activities) {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      continue;
    }
    if (activity.kind === "approval.requested") {
      openApprovalRequestIds.add(requestId);
      continue;
    }
    if (activity.kind === "approval.resolved") {
      openApprovalRequestIds.delete(requestId);
      continue;
    }
    if (
      activity.kind === "provider.approval.respond.failed" &&
      isStalePendingRequestFailure(extractActivityFailureDetail(activity.payload))
    ) {
      openApprovalRequestIds.delete(requestId);
      continue;
    }
    if (activity.kind === "user-input.requested") {
      openUserInputRequestIds.add(requestId);
      continue;
    }
    if (activity.kind === "user-input.resolved") {
      openUserInputRequestIds.delete(requestId);
      continue;
    }
    if (
      activity.kind === "provider.user-input.respond.failed" &&
      isStalePendingRequestFailure(extractActivityFailureDetail(activity.payload))
    ) {
      openUserInputRequestIds.delete(requestId);
    }
  }

  return activities.filter((activity) => {
    const requestId = extractActivityRequestId(activity.payload);
    if (requestId === null) {
      return true;
    }
    if (activity.kind === "approval.requested" && openApprovalRequestIds.has(requestId)) {
      return false;
    }
    if (activity.kind === "user-input.requested" && openUserInputRequestIds.has(requestId)) {
      return false;
    }
    return true;
  });
}

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

function withEventBase(input: {
  readonly command: ThreadForkCommand;
  readonly occurredAt: string;
}): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: "thread",
    aggregateId: input.command.threadId,
    occurredAt: input.occurredAt,
    commandId: input.command.commandId,
    causationEventId: null,
    correlationId: input.command.commandId,
    metadata: {},
  };
}

const makeThreadForkService = Effect.gen(function* () {
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;

  const createForkEvent: ThreadForkServiceShape["createForkEvent"] = ({ command, readModel }) =>
    Effect.gen(function* () {
      const sourceThread = yield* requireThread({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });

      const sourceTurns = yield* projectionTurnRepository.listByThreadId({
        threadId: command.sourceThreadId,
      });
      const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
        threadId: command.sourceThreadId,
      });
      if (Option.isSome(pendingTurnStart)) {
        return yield* invariantError(
          command.type,
          `Thread '${command.sourceThreadId}' is still processing and cannot be forked yet.`,
        );
      }
      if (
        sourceThread.session?.status === "running" ||
        sourceThread.session?.status === "starting"
      ) {
        return yield* invariantError(
          command.type,
          `Thread '${command.sourceThreadId}' is still processing and cannot be forked yet.`,
        );
      }
      if (
        sourceTurns.some(
          (turn) =>
            turn.turnId !== null &&
            (turn.state === "running" || (turn.startedAt !== null && turn.completedAt === null)),
        )
      ) {
        return yield* invariantError(
          command.type,
          `Thread '${command.sourceThreadId}' is still processing and cannot be forked yet.`,
        );
      }

      const sourceMessages = yield* projectionThreadMessageRepository.listByThreadId({
        threadId: command.sourceThreadId,
      });
      const sourceActivities = yield* projectionThreadActivityRepository.listByThreadId({
        threadId: command.sourceThreadId,
      });
      const sourceProposedPlans = yield* projectionThreadProposedPlanRepository.listByThreadId({
        threadId: command.sourceThreadId,
      });
      const hasPersistedHistory =
        sourceThread.latestTurn !== null ||
        sourceThread.checkpoints.length > 0 ||
        sourceTurns.some((turn) => turn.turnId !== null) ||
        sourceMessages.length > 0 ||
        sourceActivities.length > 0 ||
        sourceProposedPlans.length > 0;
      if (!hasPersistedHistory) {
        return yield* invariantError(
          command.type,
          `Thread '${command.sourceThreadId}' has no persisted history to fork.`,
        );
      }

      const retainedTurns = sourceTurns.filter(
        (turn) =>
          turn.turnId !== null &&
          turn.state !== "running" &&
          !(turn.startedAt !== null && turn.completedAt === null),
      );
      const retainedTurnIds = new Set(
        retainedTurns.flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
      );
      const retainedMessages = sourceMessages.filter(
        (message) => message.turnId === null || retainedTurnIds.has(message.turnId),
      );
      const retainedActivities = filterOpenInteractiveActivities(
        sourceActivities.filter(
          (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
        ),
      );
      const retainedProposedPlans = sourceProposedPlans.filter(
        (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
      );
      const latestRetainedTurn =
        sourceThread.latestTurn !== null
          ? (retainedTurns.find((turn) => turn.turnId === sourceThread.latestTurn?.turnId) ?? null)
          : (retainedTurns.at(-1) ?? null);

      const nextMessageIdBySourceId = new Map<string, MessageId>();
      const nextPlanIdBySourceId = new Map<string, OrchestrationProposedPlanId>();

      const messages = retainedMessages.map((message) => {
        const nextMessageId = MessageIdSchema.makeUnsafe(crypto.randomUUID());
        nextMessageIdBySourceId.set(message.messageId, nextMessageId);
        const nextMessage = {
          id: nextMessageId,
          role: message.role,
          text: message.text,
          turnId: message.turnId,
          streaming: message.isStreaming,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
        };
        if (message.attachments !== undefined) {
          return Object.assign(nextMessage, {
            attachments: [...message.attachments],
          });
        }
        return nextMessage;
      });

      const proposedPlans = retainedProposedPlans.map((proposedPlan) => {
        const nextPlanId = OrchestrationProposedPlanIdSchema.makeUnsafe(crypto.randomUUID());
        nextPlanIdBySourceId.set(proposedPlan.planId, nextPlanId);
        return {
          id: nextPlanId,
          turnId: proposedPlan.turnId,
          planMarkdown: proposedPlan.planMarkdown,
          implementedAt: proposedPlan.implementedAt,
          implementationThreadId: proposedPlan.implementationThreadId,
          createdAt: proposedPlan.createdAt,
          updatedAt: proposedPlan.updatedAt,
        };
      });

      const remapSourceProposedPlan = (input: {
        readonly threadId: ThreadId | null;
        readonly planId: OrchestrationProposedPlanId | null;
      }) => {
        if (input.threadId === null || input.planId === null) {
          return {
            threadId: input.threadId,
            planId: input.planId,
          } as const;
        }
        if (input.threadId !== command.sourceThreadId) {
          return input;
        }
        return {
          threadId: command.threadId,
          planId: nextPlanIdBySourceId.get(input.planId) ?? input.planId,
        } as const;
      };

      const activities = retainedActivities.map((activity) => {
        const nextActivity = {
          id: EventIdSchema.makeUnsafe(crypto.randomUUID()),
          tone: activity.tone,
          kind: activity.kind,
          summary: activity.summary,
          payload: activity.payload,
          turnId: activity.turnId,
          createdAt: activity.createdAt,
        };
        if (activity.sequence !== undefined) {
          return Object.assign(nextActivity, {
            sequence: activity.sequence,
          });
        }
        return nextActivity;
      });

      const turns = retainedTurns.flatMap((turn) => {
        if (turn.turnId === null) {
          return [];
        }
        const remappedSourcePlan = remapSourceProposedPlan({
          threadId: turn.sourceProposedPlanThreadId,
          planId: turn.sourceProposedPlanId,
        });
        return [
          {
            turnId: turn.turnId,
            pendingMessageId:
              turn.pendingMessageId === null
                ? null
                : (nextMessageIdBySourceId.get(turn.pendingMessageId) ?? null),
            sourceProposedPlanThreadId: remappedSourcePlan.threadId,
            sourceProposedPlanId: remappedSourcePlan.planId,
            assistantMessageId:
              turn.assistantMessageId === null
                ? null
                : (nextMessageIdBySourceId.get(turn.assistantMessageId) ?? null),
            state: turn.state,
            requestedAt: turn.requestedAt,
            startedAt: turn.startedAt,
            completedAt: turn.completedAt,
            checkpointTurnCount: turn.checkpointTurnCount,
            checkpointRef: turn.checkpointRef,
            checkpointStatus: turn.checkpointStatus,
            checkpointFiles: turn.checkpointFiles.map((file) => ({ ...file })),
          },
        ];
      });

      const checkpoints = retainedTurns.flatMap((turn) => {
        if (
          turn.turnId === null ||
          turn.checkpointTurnCount === null ||
          turn.checkpointRef === null ||
          turn.checkpointStatus === null
        ) {
          return [];
        }
        return [
          {
            turnId: turn.turnId,
            checkpointTurnCount: turn.checkpointTurnCount,
            checkpointRef: turn.checkpointRef,
            status: turn.checkpointStatus,
            files: turn.checkpointFiles.map((file) => ({ ...file })),
            assistantMessageId:
              turn.assistantMessageId === null
                ? null
                : (nextMessageIdBySourceId.get(turn.assistantMessageId) ?? null),
            completedAt: turn.completedAt ?? turn.requestedAt,
          },
        ];
      });

      const latestTurnFromReadModel: OrchestrationLatestTurn | null =
        sourceThread.latestTurn !== null &&
        sourceThread.latestTurn.state !== "running" &&
        !(
          sourceThread.latestTurn.startedAt !== null && sourceThread.latestTurn.completedAt === null
        )
          ? {
              turnId: sourceThread.latestTurn.turnId,
              state: sourceThread.latestTurn.state,
              requestedAt: sourceThread.latestTurn.requestedAt,
              startedAt: sourceThread.latestTurn.startedAt,
              completedAt: sourceThread.latestTurn.completedAt,
              assistantMessageId:
                sourceThread.latestTurn.assistantMessageId === null
                  ? null
                  : (nextMessageIdBySourceId.get(sourceThread.latestTurn.assistantMessageId) ??
                    null),
              ...(sourceThread.latestTurn.sourceProposedPlan
                ? (() => {
                    const remappedLatestSourcePlan = remapSourceProposedPlan({
                      threadId: sourceThread.latestTurn.sourceProposedPlan.threadId,
                      planId: sourceThread.latestTurn.sourceProposedPlan.planId,
                    });
                    return remappedLatestSourcePlan.threadId !== null &&
                      remappedLatestSourcePlan.planId !== null
                      ? {
                          sourceProposedPlan: {
                            threadId: remappedLatestSourcePlan.threadId,
                            planId: remappedLatestSourcePlan.planId,
                          },
                        }
                      : {};
                  })()
                : {}),
            }
          : null;
      const latestTurnFromProjection: OrchestrationLatestTurn | null =
        latestRetainedTurn !== null && latestRetainedTurn.turnId !== null
          ? (() => {
              const remappedLatestSourcePlan = remapSourceProposedPlan({
                threadId: latestRetainedTurn.sourceProposedPlanThreadId,
                planId: latestRetainedTurn.sourceProposedPlanId,
              });
              return {
                turnId: latestRetainedTurn.turnId,
                state: projectionTurnStateToLatestTurnState(latestRetainedTurn.state),
                requestedAt: latestRetainedTurn.requestedAt,
                startedAt: latestRetainedTurn.startedAt,
                completedAt: latestRetainedTurn.completedAt,
                assistantMessageId:
                  latestRetainedTurn.assistantMessageId === null
                    ? null
                    : (nextMessageIdBySourceId.get(latestRetainedTurn.assistantMessageId) ?? null),
                ...(remappedLatestSourcePlan.threadId !== null &&
                remappedLatestSourcePlan.planId !== null
                  ? {
                      sourceProposedPlan: {
                        threadId: remappedLatestSourcePlan.threadId,
                        planId: remappedLatestSourcePlan.planId,
                      },
                    }
                  : {}),
              } satisfies OrchestrationLatestTurn;
            })()
          : null;
      const latestTurn = latestTurnFromReadModel ?? latestTurnFromProjection;
      const forkOriginCheckpointTurnCount =
        latestRetainedTurn !== null &&
        latestTurn !== null &&
        latestRetainedTurn.turnId !== null &&
        latestRetainedTurn.turnId === latestTurn.turnId
          ? latestRetainedTurn.checkpointTurnCount
          : null;

      return {
        ...withEventBase({
          command,
          occurredAt: command.createdAt,
        }),
        type: "thread.forked" as const,
        payload: {
          threadId: command.threadId,
          projectId: sourceThread.projectId,
          title: truncateThreadTitle(`Fork: ${sourceThread.title}`),
          model: sourceThread.modelSelection.model,
          runtimeMode: sourceThread.runtimeMode,
          interactionMode: sourceThread.interactionMode,
          branch: sourceThread.branch,
          worktreePath: sourceThread.worktreePath,
          forkOrigin: {
            sourceThreadId: command.sourceThreadId,
            sourceTurnId: latestTurn?.turnId ?? null,
            sourceCheckpointTurnCount: forkOriginCheckpointTurnCount,
            forkedAt: command.createdAt,
          },
          latestTurn,
          messages,
          proposedPlans,
          activities,
          checkpoints,
          turns,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    });

  return {
    createForkEvent,
  } satisfies ThreadForkServiceShape;
});

export const ThreadForkServiceLive = Layer.effect(ThreadForkService, makeThreadForkService).pipe(
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
);
