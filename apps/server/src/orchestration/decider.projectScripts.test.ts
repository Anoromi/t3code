import {
  CommandId,
  CheckpointRef,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);

describe("decider project scripts", () => {
  it("remaps globally keyed fork history ids", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const projectId = asProjectId("project-fork");
    const sourceThreadId = asThreadId("thread-source");
    const forkThreadId = asThreadId("thread-fork");
    const sourceAssistantMessageId = asMessageId("message-assistant-source");
    const sourcePlanId = "plan-source";
    const sourceActivityId = asEventId("activity-source");

    const readModel = {
      ...createEmptyReadModel(now),
      projects: [
        {
          id: projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          worktreeGroupTitles: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: sourceThreadId,
          projectId,
          title: "Source",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required" as const,
          branch: "feature/source",
          worktreePath: "/tmp/project/.worktrees/source",
          forkOrigin: null,
          latestTurn: {
            turnId: asTurnId("turn-source"),
            state: "completed" as const,
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            assistantMessageId: sourceAssistantMessageId,
            sourceProposedPlan: {
              threadId: sourceThreadId,
              planId: sourcePlanId,
            },
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
          messages: [
            {
              id: sourceAssistantMessageId,
              role: "assistant" as const,
              text: "Implemented it.",
              attachments: [],
              turnId: asTurnId("turn-source"),
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
          proposedPlans: [
            {
              id: sourcePlanId,
              turnId: asTurnId("turn-source"),
              planMarkdown: "Plan",
              implementedAt: now,
              implementationThreadId: sourceThreadId,
              createdAt: now,
              updatedAt: now,
            },
          ],
          activities: [
            {
              id: sourceActivityId,
              tone: "info" as const,
              kind: "turn.completed",
              summary: "completed",
              payload: {},
              turnId: asTurnId("turn-source"),
              createdAt: now,
            },
          ],
          checkpoints: [
            {
              turnId: asTurnId("turn-source"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-source"),
              status: "ready" as const,
              files: [],
              assistantMessageId: sourceAssistantMessageId,
              completedAt: now,
            },
          ],
          session: null,
        },
      ],
    };

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.fork",
          commandId: CommandId.make("cmd-thread-fork"),
          threadId: forkThreadId,
          forkSourceThreadId: sourceThreadId,
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("thread.forked");
    if (event.type !== "thread.forked") {
      return;
    }

    const forkMessage = event.payload.messages[0];
    const forkPlan = event.payload.proposedPlans[0];
    const forkActivity = event.payload.activities[0];

    expect(forkMessage?.id).not.toBe(sourceAssistantMessageId);
    expect(forkPlan?.id).not.toBe(sourcePlanId);
    expect(forkActivity?.id).not.toBe(sourceActivityId);
    expect(event.payload.latestTurn?.assistantMessageId).toBe(forkMessage?.id);
    expect(event.payload.latestTurn?.sourceProposedPlan).toEqual({
      threadId: forkThreadId,
      planId: forkPlan?.id,
    });
    expect(event.payload.checkpoints[0]?.assistantMessageId).toBe(forkMessage?.id);
    expect(forkPlan?.implementationThreadId).toBe(forkThreadId);
  });

  it("emits empty scripts on project.create", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const readModel = createEmptyReadModel(now);

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-project-create-scripts"),
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.created");
    expect((event.payload as { scripts: unknown[] }).scripts).toEqual([]);
  });

  it("emits worktree group title regeneration requests", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const projectId = asProjectId("project-worktree-title");
    const readModel = {
      ...createEmptyReadModel(now),
      projects: [
        {
          id: projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          worktreeGroupTitles: [],
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        },
      ],
    };

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.worktree-group-title.regenerate",
          commandId: CommandId.make("cmd-worktree-title-regenerate"),
          projectId,
          worktreePath: "/tmp/project/.worktrees/feature",
          createdAt: now,
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event).toMatchObject({
      type: "project.worktree-group-title-regeneration-requested",
      payload: {
        projectId,
        worktreePath: "/tmp/project/.worktrees/feature",
        createdAt: now,
      },
    });
  });

  it("propagates scripts in project.meta.update payload", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const initial = createEmptyReadModel(now);
    const readModel = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create-scripts"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-scripts"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create-scripts"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create-scripts"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-scripts"),
          title: "Scripts",
          workspaceRoot: "/tmp/scripts",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const scripts = [
      {
        id: "lint",
        name: "Lint",
        command: "bun run lint",
        icon: "lint",
        runOnWorktreeCreate: false,
      },
    ] as const;

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-project-update-scripts"),
          projectId: asProjectId("project-scripts"),
          scripts: Array.from(scripts),
        },
        readModel,
      }),
    );

    const event = Array.isArray(result) ? result[0] : result;
    expect(event.type).toBe("project.meta-updated");
    expect((event.payload as { scripts?: unknown[] }).scripts).toEqual(scripts);
  });

  it("emits user message and turn-start-requested events for thread.turn.start", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-turn-start"),
          threadId: ThreadId.make("thread-1"),
          message: {
            messageId: asMessageId("message-user-1"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: true },
          ]),
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    expect(Array.isArray(result)).toBe(true);
    const events = Array.isArray(result) ? result : [result];
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("thread.message-sent");
    const turnStartEvent = events[1];
    expect(turnStartEvent?.type).toBe("thread.turn-start-requested");
    expect(turnStartEvent?.causationEventId).toBe(events[0]?.eventId ?? null);
    if (turnStartEvent?.type !== "thread.turn-start-requested") {
      return;
    }
    expect(turnStartEvent.payload).toMatchObject({
      threadId: ThreadId.make("thread-1"),
      messageId: asMessageId("message-user-1"),
      modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
      runtimeMode: "approval-required",
    });
  });

  it("emits thread.runtime-mode-set from thread.runtime-mode.set", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime-mode-set"),
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "approval-required",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single runtime-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.runtime-mode-set",
      payload: {
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "approval-required",
      },
    });
  });

  it("emits thread.interaction-mode-set from thread.interaction-mode.set", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const initial = createEmptyReadModel(now);
    const withProject = await Effect.runPromise(
      projectEvent(initial, {
        sequence: 1,
        eventId: asEventId("evt-project-create"),
        aggregateKind: "project",
        aggregateId: asProjectId("project-1"),
        type: "project.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-project-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-project-create"),
        metadata: {},
        payload: {
          projectId: asProjectId("project-1"),
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
    const readModel = await Effect.runPromise(
      projectEvent(withProject, {
        sequence: 2,
        eventId: asEventId("evt-thread-create"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.created",
        occurredAt: now,
        commandId: CommandId.make("cmd-thread-create"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-thread-create"),
        metadata: {},
        payload: {
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-interaction-mode-set"),
          threadId: ThreadId.make("thread-1"),
          interactionMode: "plan",
          createdAt: now,
        },
        readModel,
      }),
    );

    const singleResult = Array.isArray(result) ? null : result;
    if (singleResult === null) {
      throw new Error("Expected a single interaction-mode-set event.");
    }
    expect(singleResult).toMatchObject({
      type: "thread.interaction-mode-set",
      payload: {
        threadId: ThreadId.make("thread-1"),
        interactionMode: "plan",
      },
    });
  });
});
