import {
  type EditorId,
  type GitStackedAction,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { buildMenuItems, resolveQuickAction } from "../GitActionsControl.logic";
import { GitHubIcon } from "../Icons";
import { CommandDialog, CommandDialogPopup, CommandPanel, CommandShortcut } from "../ui/command";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import {
  gitMutationKeys,
  gitPullMutationOptions,
  gitRunStackedActionMutationOptions,
} from "~/lib/gitReactQuery";
import { useGitStatus } from "~/lib/gitStatusState";
import { cn, randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { shortcutLabelForCommand } from "~/keybindings";
import { commandForProjectScript } from "~/projectScripts";
import { resolveOpenInOptions } from "./openInOptions";
import { ProjectScriptIcon } from "./projectScriptPresentation";
import {
  dedupeThreadCommandBarItems,
  filterThreadCommandBarGroups,
  type ThreadCommandBarGroup,
  type ThreadCommandBarItem,
} from "./ThreadCommandBar.logic";

interface ThreadCommandBarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeThreadRef: ScopedThreadRef | null;
  activeProjectScripts: readonly ProjectScript[] | undefined;
  availableEditors: ReadonlyArray<EditorId>;
  gitCwd: string | null;
  openInCwd: string | null;
  keybindings: ResolvedKeybindingsConfig;
  onRunProjectScript: (
    script: ProjectScript,
    options?: { rememberAsLastInvoked?: boolean },
  ) => Promise<void> | void;
}

function GitCommandIcon({ action }: { action: GitStackedAction | "pull" | "open_pr" | "hint" }) {
  if (action === "pull" || action === "push" || action === "commit_push") {
    return <span className="size-4 text-muted-foreground/80">{"\u2191"}</span>;
  }
  if (action === "commit") {
    return <span className="size-4 text-muted-foreground/80">{"\u25cf"}</span>;
  }
  if (action === "hint") {
    return <span className="size-4 text-muted-foreground/80">{"i"}</span>;
  }
  return <GitHubIcon className="size-4 text-muted-foreground/80" />;
}

function gitActionSearchTerms(action: GitStackedAction | "pull" | "open_pr" | "hint"): string[] {
  if (action === "commit_push") return ["commit push sync"];
  if (action === "commit_push_pr") return ["commit push pr pull request sync"];
  if (action === "create_pr") return ["create pr pull request github"];
  if (action === "open_pr") return ["view pr open pull request github"];
  if (action === "pull") return ["pull sync branch upstream"];
  if (action === "push") return ["push sync branch upstream"];
  if (action === "commit") return ["commit changes"];
  return ["git status"];
}

function resolveQuickActionDisplayAction(input: {
  kind: "run_action" | "run_pull" | "open_pr" | "show_hint" | "open_publish";
  action?: GitStackedAction | undefined;
}): GitStackedAction | "pull" | "open_pr" | "hint" {
  if (input.action) return input.action;
  if (input.kind === "run_pull") return "pull";
  if (input.kind === "open_pr") return "open_pr";
  return "hint";
}

export function ThreadCommandBar({
  activeProjectScripts,
  activeThreadRef,
  availableEditors,
  gitCwd,
  keybindings,
  onOpenChange,
  onRunProjectScript,
  open,
  openInCwd,
}: ThreadCommandBarProps) {
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listId = useId();
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());
  const queryClient = useQueryClient();
  const activeEnvironmentId = activeThreadRef?.environmentId ?? null;
  const threadToastData = useMemo(
    () => (activeThreadRef ? { threadRef: activeThreadRef } : undefined),
    [activeThreadRef],
  );
  const { data: gitStatus = null } = useGitStatus({
    environmentId: activeEnvironmentId,
    cwd: gitCwd,
  });
  const isRepo = gitStatus?.isRepo ?? false;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;
  const isRunStackedActionRunning =
    useIsMutating({
      mutationKey: gitMutationKeys.runStackedAction(activeEnvironmentId, gitCwd),
    }) > 0;
  const isPullRunning =
    useIsMutating({ mutationKey: gitMutationKeys.pull(activeEnvironmentId, gitCwd) }) > 0;
  const isGitActionRunning = isRunStackedActionRunning || isPullRunning;

  const runStackedActionMutation = useMutation(
    gitRunStackedActionMutationOptions({
      environmentId: activeEnvironmentId,
      cwd: gitCwd,
      queryClient,
    }),
  );
  const pullMutation = useMutation(
    gitPullMutationOptions({ environmentId: activeEnvironmentId, cwd: gitCwd, queryClient }),
  );

  useEffect(() => {
    if (open) return;
    setQuery("");
    setHighlightedIndex(0);
  }, [open]);

  const openExistingPr = useCallback(async () => {
    const api = readLocalApi();
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!api || !prUrl) {
      toastManager.add({
        type: "error",
        title: "No open PR found.",
        data: threadToastData,
      });
      return;
    }
    await api.shell.openExternal(prUrl);
  }, [gitStatus?.pr, threadToastData]);

  const runPull = useCallback(() => {
    const promise = pullMutation.mutateAsync();
    toastManager.promise(promise, {
      loading: { title: "Pulling...", data: threadToastData },
      success: (result) => ({
        title: result.status === "pulled" ? "Pulled" : "Already up to date",
        description:
          result.status === "pulled"
            ? `Updated ${result.refName} from ${result.upstreamRef ?? "upstream"}`
            : `${result.refName} is already synchronized.`,
        data: threadToastData,
      }),
      error: (err) => ({
        title: "Pull failed",
        description: err instanceof Error ? err.message : "An error occurred.",
        data: threadToastData,
      }),
    });
    void promise.catch(() => undefined);
  }, [pullMutation, threadToastData]);

  const runStackedAction = useCallback(
    (action: GitStackedAction) => {
      const promise = runStackedActionMutation.mutateAsync({
        actionId: randomUUID(),
        action,
      });
      toastManager.promise(promise, {
        loading: { title: "Running git action...", data: threadToastData },
        success: (result) => ({
          title: result.toast.title,
          description: result.toast.description,
          data: threadToastData,
        }),
        error: (err) => ({
          title: "Action failed",
          description: err instanceof Error ? err.message : "An error occurred.",
          data: threadToastData,
        }),
      });
      void promise.catch(() => undefined);
    },
    [runStackedActionMutation, threadToastData],
  );

  const commandItems = useMemo<ThreadCommandBarItem[]>(() => {
    const scriptItems: ThreadCommandBarItem[] = (activeProjectScripts ?? []).map((script) => ({
      id: `script:${script.id}`,
      group: "actions",
      title: script.runOnWorktreeCreate ? `${script.name} (setup)` : script.name,
      description: script.command,
      searchTerms: [script.name, script.command, script.runOnWorktreeCreate ? "setup" : ""],
      icon: <ProjectScriptIcon icon={script.icon} className="size-4 text-muted-foreground/80" />,
      shortcutCommand: commandForProjectScript(script.id),
      run: () => onRunProjectScript(script, { rememberAsLastInvoked: false }),
    }));

    const canOpenIn = openInCwd !== null && readLocalApi() !== null;
    const openInItems: ThreadCommandBarItem[] = resolveOpenInOptions(
      navigator.platform,
      availableEditors,
    ).map(({ Icon, label, value }) => ({
      id: `open-in:${value}`,
      group: "open-in",
      title: `Open in ${label}`,
      description: openInCwd ?? "No workspace path available",
      searchTerms: ["open", label, value, openInCwd ?? ""],
      icon: <Icon className="size-4 text-muted-foreground/80" />,
      disabled: !canOpenIn,
      disabledReason: "Opening in an editor is unavailable.",
      run: async () => {
        const api = readLocalApi();
        if (!api || !openInCwd) return;
        await api.shell.openInEditor(openInCwd, value);
      },
    }));

    const gitItems: ThreadCommandBarItem[] = [];
    if (gitCwd && isRepo) {
      const quickAction = resolveQuickAction(
        gitStatus,
        isGitActionRunning,
        isDefaultRef,
        hasPrimaryRemote,
      );
      const quickActionId =
        quickAction.kind === "run_action" && quickAction.action
          ? `git:${quickAction.action}`
          : `git:${quickAction.kind}`;
      const quickDisplayAction = resolveQuickActionDisplayAction(quickAction);
      gitItems.push({
        id: quickActionId,
        group: "git",
        title: quickAction.label,
        description: quickAction.hint ?? gitCwd,
        searchTerms: gitActionSearchTerms(quickDisplayAction),
        icon: <GitCommandIcon action={quickDisplayAction} />,
        disabled: quickAction.disabled,
        disabledReason: quickAction.hint ?? "This git action is unavailable.",
        run: () => {
          if (quickAction.kind === "open_pr") return openExistingPr();
          if (quickAction.kind === "run_pull") return runPull();
          if (quickAction.kind === "show_hint" || quickAction.kind === "open_publish") {
            toastManager.add({
              type: "info",
              title: quickAction.label,
              description: quickAction.hint,
              data: threadToastData,
            });
            return;
          }
          if (quickAction.action) runStackedAction(quickAction.action);
        },
      });

      for (const menuItem of buildMenuItems(gitStatus, isGitActionRunning, hasPrimaryRemote)) {
        const action =
          menuItem.kind === "open_pr"
            ? "open_pr"
            : menuItem.dialogAction === "push"
              ? "push"
              : menuItem.dialogAction === "create_pr"
                ? "create_pr"
                : "commit";
        gitItems.push({
          id: `git:${action}`,
          group: "git",
          title: menuItem.label,
          description: gitCwd,
          searchTerms: gitActionSearchTerms(action),
          icon: <GitCommandIcon action={action} />,
          disabled: menuItem.disabled,
          ...(menuItem.disabled ? { disabledReason: "This git action is unavailable." } : {}),
          run: () => {
            if (action === "open_pr") return openExistingPr();
            runStackedAction(action);
          },
        });
      }
    }

    return dedupeThreadCommandBarItems([...scriptItems, ...openInItems, ...gitItems]);
  }, [
    activeProjectScripts,
    availableEditors,
    gitCwd,
    gitStatus,
    hasPrimaryRemote,
    isDefaultRef,
    isGitActionRunning,
    isRepo,
    onRunProjectScript,
    openExistingPr,
    openInCwd,
    runPull,
    runStackedAction,
    threadToastData,
  ]);

  const groups = useMemo(
    () => filterThreadCommandBarGroups({ items: commandItems, query }),
    [commandItems, query],
  );
  const flatItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const hasItems = commandItems.length > 0;
  const hasResults = flatItems.length > 0;
  const activeOptionId = hasResults ? `${listId}-option-${highlightedIndex}` : undefined;

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  useEffect(() => {
    setHighlightedIndex((current) => {
      if (flatItems.length === 0) return 0;
      return Math.min(current, flatItems.length - 1);
    });
  }, [flatItems.length]);

  useLayoutEffect(() => {
    if (!open || !hasResults) return;
    optionRefs.current.get(highlightedIndex)?.scrollIntoView({ block: "nearest" });
  }, [hasResults, highlightedIndex, open]);

  const executeItem = useCallback(
    (item: ThreadCommandBarItem) => {
      if (item.disabled) {
        toastManager.add({
          type: "info",
          title: item.title,
          description: item.disabledReason,
          data: threadToastData,
        });
        return;
      }
      onOpenChange(false);
      void Promise.resolve(item.run()).catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Unable to run command",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
          data: threadToastData,
        });
      });
    },
    [onOpenChange, threadToastData],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((current) =>
          flatItems.length === 0 ? 0 : Math.min(current + 1, flatItems.length - 1),
        );
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIndex((current) => Math.max(current - 1, 0));
        return;
      }

      if (event.key === "Home") {
        event.preventDefault();
        setHighlightedIndex(0);
        return;
      }

      if (event.key === "End") {
        event.preventDefault();
        setHighlightedIndex(flatItems.length === 0 ? 0 : flatItems.length - 1);
        return;
      }

      if (event.key === "Enter") {
        const item = flatItems[highlightedIndex];
        if (!item) return;
        event.preventDefault();
        executeItem(item);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
      }
    },
    [executeItem, flatItems, highlightedIndex, onOpenChange],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup
        aria-label="Thread command bar"
        className="h-[min(30rem,72vh)] max-h-[min(30rem,72vh)] transition-[scale,opacity] duration-75 ease-out data-ending-style:translate-y-0 data-starting-style:translate-y-0 data-nested:data-ending-style:translate-y-0 data-nested:data-starting-style:translate-y-0"
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="px-2.5 py-1.5">
            <div className="relative w-full min-w-0 text-foreground">
              <div
                aria-hidden="true"
                className="[&_svg]:-mx-0.5 pointer-events-none absolute inset-y-0 start-px z-10 flex items-center ps-[calc(--spacing(3)-1px)] opacity-80 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4"
              >
                <SearchIcon />
              </div>
              <Input
                aria-activedescendant={activeOptionId}
                aria-autocomplete="list"
                aria-controls={listId}
                aria-expanded={open}
                autoFocus
                className="border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0 *:data-[slot=input]:ps-[calc(--spacing(8.5)-1px)] sm:*:data-[slot=input]:ps-[calc(--spacing(8)-1px)]"
                nativeInput
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="Search commands..."
                role="combobox"
                size="lg"
                type="search"
                unstyled
                value={query}
              />
            </div>
          </div>
          <CommandPanel className="flex-1 min-h-0">
            <ScrollArea scrollbarGutter scrollFade>
              <div
                id={listId}
                className="h-full max-h-none not-empty:scroll-py-2 not-empty:p-2"
                role="listbox"
              >
                {hasResults ? (
                  <ThreadCommandBarResults
                    groups={groups}
                    highlightedIndex={highlightedIndex}
                    keybindings={keybindings}
                    listId={listId}
                    optionRefs={optionRefs}
                    onExecuteItem={executeItem}
                    onHighlight={setHighlightedIndex}
                  />
                ) : (
                  <div className="flex min-h-full items-center justify-center not-empty:py-6 text-center text-base text-muted-foreground sm:text-sm">
                    {hasItems ? "No matching commands." : "No commands available for this thread."}
                  </div>
                )}
              </div>
            </ScrollArea>
          </CommandPanel>
        </div>
      </CommandDialogPopup>
    </CommandDialog>
  );
}

function ThreadCommandBarResults({
  groups,
  highlightedIndex,
  keybindings,
  listId,
  onExecuteItem,
  onHighlight,
  optionRefs,
}: {
  groups: ReadonlyArray<ThreadCommandBarGroup>;
  highlightedIndex: number;
  keybindings: ResolvedKeybindingsConfig;
  listId: string;
  onExecuteItem: (item: ThreadCommandBarItem) => void;
  onHighlight: (index: number) => void;
  optionRefs: React.RefObject<Map<number, HTMLButtonElement>>;
}) {
  let itemIndex = 0;
  return (
    <>
      {groups.map((group) => (
        <div key={group.id} className="py-1">
          <div className="px-2 pb-1 text-muted-foreground text-xs">{group.label}</div>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const currentIndex = itemIndex;
              itemIndex += 1;
              const shortcutLabel = item.shortcutCommand
                ? shortcutLabelForCommand(keybindings, item.shortcutCommand)
                : null;
              const isActive = highlightedIndex === currentIndex;
              return (
                <button
                  aria-disabled={item.disabled ? "true" : undefined}
                  aria-selected={isActive}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                    isActive && "bg-accent text-accent-foreground",
                    item.disabled && "text-muted-foreground",
                  )}
                  id={`${listId}-option-${currentIndex}`}
                  key={item.id}
                  onClick={() => onExecuteItem(item)}
                  onMouseEnter={() => onHighlight(currentIndex)}
                  ref={(node) => {
                    if (node) {
                      optionRefs.current.set(currentIndex, node);
                    } else {
                      optionRefs.current.delete(currentIndex);
                    }
                  }}
                  role="option"
                  type="button"
                >
                  {item.icon}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm text-foreground">{item.title}</span>
                    {item.description ? (
                      <span className="truncate text-muted-foreground/70 text-xs">
                        {item.description}
                      </span>
                    ) : null}
                  </span>
                  {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}
