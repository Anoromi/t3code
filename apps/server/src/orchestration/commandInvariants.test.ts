import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import {
  findThreadById,
  latestTurnIsForkSettled,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
  requireThreadHasForkableHistory,
  requireThreadSettledForFork,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.makeUnsafe("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      worktreeGroupTitles: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.makeUnsafe("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      worktreeGroupTitles: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.makeUnsafe("thread-1"),
      projectId: ProjectId.makeUnsafe("project-a"),
      title: "Thread A",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      forkOrigin: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.makeUnsafe("thread-2"),
      projectId: ProjectId.makeUnsafe("project-b"),
      title: "Thread B",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      forkOrigin: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.makeUnsafe("cmd-1"),
  threadId: ThreadId.makeUnsafe("thread-1"),
  message: {
    messageId: MessageId.makeUnsafe("msg-1"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.makeUnsafe("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.makeUnsafe("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.makeUnsafe("project-b")).map(
        (thread) => thread.id,
      ),
    ).toEqual([ThreadId.makeUnsafe("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.makeUnsafe("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.makeUnsafe("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.makeUnsafe("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-2"),
          threadId: ThreadId.makeUnsafe("thread-3"),
          projectId: ProjectId.makeUnsafe("project-a"),
          title: "new",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.makeUnsafe("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-3"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            projectId: ProjectId.makeUnsafe("project-a"),
            title: "dup",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.makeUnsafe("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });

  it("requires persisted history before forking", async () => {
    await expect(
      Effect.runPromise(
        requireThreadHasForkableHistory({
          command: {
            type: "thread.fork",
            commandId: CommandId.makeUnsafe("cmd-fork-no-history"),
            threadId: ThreadId.makeUnsafe("thread-fork"),
            sourceThreadId: ThreadId.makeUnsafe("thread-1"),
            createdAt: now,
          },
          thread: readModel.threads[0]!,
        }),
      ),
    ).rejects.toThrow("has no persisted history to fork");
  });

  it("treats completed latest turns as settled for forking", () => {
    expect(
      latestTurnIsForkSettled({
        turnId: TurnId.makeUnsafe("turn-1"),
        state: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        assistantMessageId: null,
      }),
    ).toBe(true);
    expect(
      latestTurnIsForkSettled({
        turnId: TurnId.makeUnsafe("turn-2"),
        state: "running",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        assistantMessageId: null,
      }),
    ).toBe(false);
  });

  it("rejects forking while a thread is still running", async () => {
    await expect(
      Effect.runPromise(
        requireThreadSettledForFork({
          command: {
            type: "thread.fork",
            commandId: CommandId.makeUnsafe("cmd-fork-running"),
            threadId: ThreadId.makeUnsafe("thread-fork"),
            sourceThreadId: ThreadId.makeUnsafe("thread-running"),
            createdAt: now,
          },
          thread: {
            ...readModel.threads[0]!,
            messages: [
              {
                id: MessageId.makeUnsafe("msg-running"),
                role: "user",
                text: "hello",
                attachments: [],
                turnId: null,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            ],
            latestTurn: {
              turnId: TurnId.makeUnsafe("turn-running"),
              state: "running",
              requestedAt: now,
              startedAt: now,
              completedAt: null,
              assistantMessageId: null,
            },
            session: {
              threadId: ThreadId.makeUnsafe("thread-running"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: TurnId.makeUnsafe("turn-running"),
              lastError: null,
              updatedAt: now,
            },
          },
        }),
      ),
    ).rejects.toThrow("is still processing and cannot be forked yet");
  });
});
