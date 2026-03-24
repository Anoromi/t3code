import { MessageId, ThreadId, TurnId, type OrchestrationLatestTurn } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildExpiredTerminalContextToastCopy,
  deriveComposerSendState,
  hasForkableThreadHistory,
  isThreadForkReady,
} from "./ChatView.logic";

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats clear empty-state guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
  });

  it("formats omission guidance for sent messages", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("fork readiness", () => {
  const settledLatestTurn: OrchestrationLatestTurn = {
    turnId: TurnId.makeUnsafe("turn-1"),
    state: "completed",
    requestedAt: "2026-03-17T12:52:29.000Z",
    startedAt: "2026-03-17T12:52:30.000Z",
    completedAt: "2026-03-17T12:52:31.000Z",
    assistantMessageId: null,
  };

  it("counts reply-only server history as forkable even without checkpoints", () => {
    expect(
      hasForkableThreadHistory({
        messages: [
          {
            id: MessageId.makeUnsafe("msg-user-1"),
            role: "user",
            text: "testing",
            streaming: false,
            createdAt: "2026-03-17T12:52:29.000Z",
          },
          {
            id: MessageId.makeUnsafe("msg-assistant-1"),
            role: "assistant",
            text: "Received. I'm ready in /tmp/repo.",
            streaming: false,
            createdAt: "2026-03-17T12:52:30.000Z",
          },
        ],
        activities: [],
        proposedPlans: [],
        turnDiffSummaries: [],
        latestTurn: null,
        session: null,
      }),
    ).toBe(true);
  });

  it("treats settled history without checkpoints as fork-ready", () => {
    expect(
      isThreadForkReady({
        thread: {
          messages: [
            {
              id: MessageId.makeUnsafe("msg-user-1"),
              role: "user",
              text: "testing",
              streaming: false,
              createdAt: "2026-03-17T12:52:29.000Z",
            },
            {
              id: MessageId.makeUnsafe("msg-assistant-1"),
              role: "assistant",
              text: "Received. I'm ready in /tmp/repo.",
              streaming: false,
              createdAt: "2026-03-17T12:52:30.000Z",
            },
          ],
          activities: [],
          proposedPlans: [],
          turnDiffSummaries: [],
          latestTurn: settledLatestTurn,
          session: {
            provider: "codex",
            status: "ready",
            createdAt: "2026-03-17T12:52:29.000Z",
            updatedAt: "2026-03-17T12:52:31.000Z",
            orchestrationStatus: "ready",
          },
        },
        isServerThread: true,
        phase: "ready",
        isSendBusy: false,
        isConnecting: false,
        isRevertingCheckpoint: false,
      }),
    ).toBe(true);
  });

  it("blocks forking while a latest turn is still in flight", () => {
    expect(
      isThreadForkReady({
        thread: {
          messages: [
            {
              id: MessageId.makeUnsafe("msg-user-1"),
              role: "user",
              text: "testing",
              streaming: false,
              createdAt: "2026-03-17T12:52:29.000Z",
            },
          ],
          activities: [],
          proposedPlans: [],
          turnDiffSummaries: [],
          latestTurn: {
            ...settledLatestTurn,
            state: "running",
            completedAt: null,
          },
          session: {
            provider: "codex",
            status: "running",
            createdAt: "2026-03-17T12:52:29.000Z",
            updatedAt: "2026-03-17T12:52:31.000Z",
            orchestrationStatus: "running",
          },
        },
        isServerThread: true,
        phase: "running",
        isSendBusy: false,
        isConnecting: false,
        isRevertingCheckpoint: false,
      }),
    ).toBe(false);
  });
});
