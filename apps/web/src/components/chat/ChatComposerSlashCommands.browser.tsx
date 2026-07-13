import "../../index.css";

import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  type VcsRef,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createModelSelection } from "@t3tools/shared/model";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { createRef } from "react";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import type { Thread } from "../../types";
import { ChatComposer, type ChatComposerHandle } from "./ChatComposer";

const refs: VcsRef[] = [
  { name: "main", current: true, isDefault: true, worktreePath: "/repo" },
  {
    name: "feature/existing",
    current: false,
    isDefault: false,
    worktreePath: "/repo/worktrees/existing",
  },
];
let branchRefsPending = false;

vi.mock("../../state/queries", () => ({
  usePaginatedBranches: ({ query }: { query?: string }) => ({
    refs: refs.filter((ref) => !query || ref.name.toLowerCase().includes(query.toLowerCase())),
    data: { totalCount: refs.length, nextCursor: null },
    isPending: branchRefsPending,
    loadNext: vi.fn(),
    refresh: vi.fn(),
  }),
}));

vi.mock("../../lib/composerPathSearchState", () => ({
  useComposerPathSearch: () => ({ entries: [], isLoading: false }),
}));

vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: () => false,
}));

const ENVIRONMENT_ID = EnvironmentId.make("environment-slash-test");
const PROJECT_ID = ProjectId.make("project-slash-test");
const THREAD_ID = ThreadId.make("thread-slash-test");
const DRAFT_ID = DraftId.make("draft-slash-test");
const INSTANCE_ID = ProviderInstanceId.make("codex");
const DRIVER = ProviderDriverKind.make("codex");
const MODEL = "descriptor-model";
const NOW = "2026-07-12T00:00:00.000Z";

const provider: ServerProvider = {
  instanceId: INSTANCE_ID,
  driver: DRIVER,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [
    {
      slug: MODEL,
      name: "Descriptor model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "normal", label: "Normal", isDefault: true },
              { id: "high", label: "High" },
              { id: "ultrathink", label: "Ultrathink" },
            ],
            promptInjectedValues: ["ultrathink"],
          },
          { id: "fastMode", label: "Fast mode", type: "boolean", currentValue: false },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const activeThread: Thread = {
  environmentId: ENVIRONMENT_ID,
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Slash command test",
  modelSelection: createModelSelection(INSTANCE_ID, MODEL),
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

function resetDraft() {
  branchRefsPending = false;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "slash-project",
      { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
      DRAFT_ID,
      {
        threadId: THREAD_ID,
        branch: "main",
        worktreePath: null,
        envMode: "local",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: NOW,
      },
    );
  useComposerDraftStore
    .getState()
    .setModelSelection(DRAFT_ID, createModelSelection(INSTANCE_ID, MODEL));
}

async function mountComposer(
  onSelectRunContext = vi.fn(),
  providerStatuses: ReadonlyArray<ServerProvider> = [provider],
) {
  const composerRef = createRef<ChatComposerHandle>();
  const promptRef = { current: "" };
  const onSend = vi.fn((event?: { preventDefault: () => void }) => event?.preventDefault());
  const screen = await render(
    <ChatComposer
      composerRef={composerRef}
      composerDraftTarget={DRAFT_ID}
      environmentId={ENVIRONMENT_ID}
      routeKind="draft"
      routeThreadRef={scopeThreadRef(ENVIRONMENT_ID, THREAD_ID)}
      draftId={DRAFT_ID}
      activeThreadId={THREAD_ID}
      activeThreadEnvironmentId={ENVIRONMENT_ID}
      activeThread={activeThread}
      isServerThread={false}
      isLocalDraftThread
      phase="ready"
      isConnecting={false}
      isSendBusy={false}
      isPreparingWorktree={false}
      environmentUnavailable={null}
      activePendingApproval={null}
      pendingApprovals={[]}
      pendingUserInputs={[]}
      activePendingProgress={null}
      activePendingResolvedAnswers={null}
      activePendingIsResponding={false}
      activePendingDraftAnswers={{}}
      activePendingQuestionIndex={0}
      respondingRequestIds={[]}
      showPlanFollowUpPrompt={false}
      activeProposedPlan={null}
      activePlan={null}
      sidebarProposedPlan={null}
      planSidebarLabel="Plan"
      planSidebarOpen={false}
      runtimeMode="full-access"
      interactionMode="default"
      lockedProvider={null}
      providerStatuses={[...providerStatuses]}
      activeProjectDefaultModelSelection={createModelSelection(INSTANCE_ID, MODEL)}
      activeThreadModelSelection={createModelSelection(INSTANCE_ID, MODEL)}
      activeThreadActivities={[]}
      resolvedTheme="dark"
      settings={DEFAULT_UNIFIED_SETTINGS}
      keybindings={[] as ResolvedKeybindingsConfig}
      terminalOpen={false}
      gitCwd="/repo"
      activeProjectCwd="/repo"
      canChangeWorktreeContext
      runContextEnvMode="local"
      activeRunContextBranch="main"
      activeRunContextWorktreePath={null}
      promptRef={promptRef}
      composerImagesRef={{ current: [] }}
      composerTerminalContextsRef={{ current: [] }}
      composerElementContextsRef={{ current: [] }}
      onSend={onSend}
      onInterrupt={vi.fn()}
      onImplementPlanInNewThread={vi.fn()}
      onRespondToApproval={vi.fn(async () => undefined)}
      onSelectActivePendingUserInputOption={vi.fn()}
      onAdvanceActivePendingUserInput={vi.fn()}
      onPreviousActivePendingUserInputQuestion={vi.fn()}
      onChangeActivePendingUserInputCustomAnswer={vi.fn()}
      onProviderModelSelect={vi.fn()}
      onSelectRunContext={onSelectRunContext}
      getModelDisabledReason={() => null}
      toggleInteractionMode={vi.fn()}
      handleRuntimeModeChange={vi.fn()}
      handleInteractionModeChange={vi.fn()}
      togglePlanSidebar={vi.fn()}
      focusComposer={vi.fn()}
      scheduleComposerFocus={vi.fn()}
      setThreadError={vi.fn()}
      onExpandImage={vi.fn()}
    />,
  );
  return { screen, onSelectRunContext, onSend };
}

describe("composer slash commands", () => {
  beforeEach(resetDraft);

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("selects a live reasoning mode with typing and Enter", async () => {
    const mounted = await mountComposer();
    try {
      const editor = page.getByTestId("composer-editor");
      await editor.fill("/reasoning high");
      await expect
        .element(page.getByRole("option", { name: /\/reasoning high/ }))
        .toBeInTheDocument();
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe("");
        expect(
          useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.modelSelectionByProvider[
            INSTANCE_ID
          ]?.options,
        ).toContainEqual({ id: "reasoningEffort", value: "high" });
      });

      await editor.fill("/reasoning normal");
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.modelSelectionByProvider[
            INSTANCE_ID
          ]?.options,
        ).toContainEqual({ id: "reasoningEffort", value: "normal" });
      });
    } finally {
      await mounted.screen.unmount();
    }
  });

  it("clears prompt-injected reasoning when selecting another mode", async () => {
    const mounted = await mountComposer();
    try {
      const editor = page.getByTestId("composer-editor");
      await editor.fill("Ultrathink:\n/reasoning high");
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() => {
        expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe("");
        expect(
          useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.modelSelectionByProvider[
            INSTANCE_ID
          ]?.options,
        ).toContainEqual({ id: "reasoningEffort", value: "high" });
      });
    } finally {
      mounted.screen.unmount();
    }
  });

  it("applies prompt-injected reasoning modes to the prompt", async () => {
    const mounted = await mountComposer();
    try {
      const editor = page.getByTestId("composer-editor");
      await editor.fill("/reasoning ultrathink");
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() => {
        const draft = useComposerDraftStore.getState().getComposerDraft(DRAFT_ID);
        expect(draft?.prompt).toBe("Ultrathink:\n");
        expect(draft?.modelSelectionByProvider[INSTANCE_ID]?.options ?? []).not.toContainEqual({
          id: "reasoningEffort",
          value: "ultrathink",
        });
      });
    } finally {
      mounted.screen.unmount();
    }
  });

  it("does not offer a named worktree until refs finish loading", async () => {
    branchRefsPending = true;
    const mounted = await mountComposer();
    try {
      await page.getByTestId("composer-editor").fill("/worktree feature/new");
      await expect
        .element(page.getByRole("option", { name: "/worktree feature/new" }))
        .not.toBeInTheDocument();
      await userEvent.keyboard("{Enter}");
      expect(mounted.onSend).not.toHaveBeenCalled();
      expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe(
        "/worktree feature/new",
      );
    } finally {
      mounted.screen.unmount();
    }
  });

  it("lists every supported keyboard action from the bare slash menu", async () => {
    const mounted = await mountComposer();
    try {
      await page.getByTestId("composer-editor").fill("/");
      for (const command of ["/model", "/branch", "/worktree", "/fast", "/reasoning"]) {
        await expect
          .element(page.getByRole("option", { name: new RegExp(`^${command}`) }))
          .toBeInTheDocument();
      }
    } finally {
      await mounted.screen.unmount();
    }
  });

  it("shows the provider default and toggles fast mode from the keyboard", async () => {
    const mounted = await mountComposer();
    try {
      const editor = page.getByTestId("composer-editor");
      await editor.fill("/reasoning ");
      await expect.element(page.getByText("Normal (default)", { exact: true })).toBeInTheDocument();

      await editor.fill("/fast");
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.modelSelectionByProvider[
            INSTANCE_ID
          ]?.options,
        ).toContainEqual({ id: "fastMode", value: true });
        expect(
          useComposerDraftStore.getState().stickyModelSelectionByProvider[INSTANCE_ID]?.options,
        ).toContainEqual({ id: "fastMode", value: true });
      });

      await editor.fill("/fast");
      await userEvent.keyboard("{Enter}");
      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.modelSelectionByProvider[
            INSTANCE_ID
          ]?.options,
        ).toContainEqual({ id: "fastMode", value: false });
      });
    } finally {
      await mounted.screen.unmount();
    }
  });

  it("leaves unsupported /fast available for normal submission", async () => {
    const providerWithoutFast: ServerProvider = {
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        capabilities: { optionDescriptors: [] },
      })),
    };
    const mounted = await mountComposer(vi.fn(), [providerWithoutFast]);
    try {
      await page.getByTestId("composer-editor").fill("/fast");
      await page.getByRole("button", { name: "Send message" }).click();
      expect(mounted.onSend).toHaveBeenCalledTimes(1);
      expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe("/fast");
    } finally {
      await mounted.screen.unmount();
    }
  });

  it("submits /fast normally when composer context is attached", async () => {
    const mounted = await mountComposer();
    try {
      await page.getByTestId("composer-editor").fill("/fast");
      useComposerDraftStore.getState().setTerminalContexts(DRAFT_ID, [
        {
          id: "context-fast-test",
          threadId: THREAD_ID,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 1,
          lineEnd: 1,
          text: "context",
          createdAt: NOW,
        },
      ]);
      await expect.element(page.getByRole("option", { name: /^\/fast/ })).not.toBeInTheDocument();
      await userEvent.keyboard("{Enter}");

      expect(mounted.onSend).toHaveBeenCalledTimes(1);
      expect(useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toContain(
        "/fast",
      );
      expect(
        useComposerDraftStore.getState().getComposerDraft(DRAFT_ID)?.modelSelectionByProvider[
          INSTANCE_ID
        ]?.options ?? [],
      ).not.toContainEqual({ id: "fastMode", value: true });
    } finally {
      await mounted.screen.unmount();
    }
  });

  it("selects branches and named worktrees without pointer input", async () => {
    const onSelectRunContext = vi.fn();
    const mounted = await mountComposer(onSelectRunContext);
    try {
      const editor = page.getByTestId("composer-editor");
      await editor.fill("/branch existing");
      await userEvent.keyboard("{Enter}");
      expect(onSelectRunContext).toHaveBeenLastCalledWith({
        branch: refs[1],
        envMode: "worktree",
      });

      await editor.fill("/branch main");
      await userEvent.keyboard("{Enter}");
      expect(onSelectRunContext).toHaveBeenLastCalledWith({
        branch: refs[0],
        envMode: "local",
      });

      await editor.fill("/worktree main");
      await userEvent.keyboard("{Enter}");
      expect(onSelectRunContext).toHaveBeenLastCalledWith({
        branch: refs[0],
        envMode: "worktree",
      });

      await editor.fill("/worktree feature/new-command");
      await userEvent.keyboard("{Enter}");
      expect(onSelectRunContext).toHaveBeenLastCalledWith({
        branch: "main",
        envMode: "worktree",
        worktreeBranchName: "feature/new-command",
      });

      await editor.fill("/worktree local");
      await userEvent.keyboard("{Enter}");
      expect(onSelectRunContext).toHaveBeenLastCalledWith({ branch: null, envMode: "local" });
    } finally {
      await mounted.screen.unmount();
    }
  });

  it("does not keep the removed /r alias open", async () => {
    const mounted = await mountComposer();
    try {
      await page.getByTestId("composer-editor").fill("/r high");
      await expect
        .element(page.getByText("/reasoning high", { exact: true }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.screen.unmount();
    }
  });
});
