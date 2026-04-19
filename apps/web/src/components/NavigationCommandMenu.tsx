import { FolderIcon, MessageSquareTextIcon, SearchIcon } from "lucide-react";
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
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { cn } from "~/lib/utils";
import { formatRelativeTime } from "~/relativeTime";
import { derivePendingApprovals, derivePendingUserInputs } from "~/session-logic";
import type { Project, Thread } from "~/types";
import { useUiStateStore } from "~/uiStateStore";
import {
  buildNavigationCommandResults,
  getProjectCommandActionLabel,
} from "./NavigationCommandMenu.logic";
import { isActionableThreadStatus, resolveThreadStatusPill } from "./Sidebar.logic";
import {
  CommandDialog,
  CommandDialogPopup,
  CommandFooter,
  CommandPanel,
  CommandShortcut,
} from "./ui/command";
import { Input } from "./ui/input";
import { ScrollArea } from "./ui/scroll-area";

export function NavigationCommandMenu(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly Project[];
  threads: readonly Thread[];
  draftProjectIds: ReadonlySet<ProjectId>;
  onSelectThread: (threadId: ThreadId) => void | Promise<void>;
  onSelectProject: (projectId: ProjectId) => void | Promise<void>;
}) {
  const {
    draftProjectIds,
    onOpenChange,
    onSelectProject,
    onSelectThread,
    open,
    projects,
    threads,
  } = props;
  const [query, setQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listId = useId();
  const optionRefs = useRef(new Map<number, HTMLButtonElement>());
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setHighlightedIndex(0);
  }, [open]);

  const threadsById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread] as const)),
    [threads],
  );

  const results = useMemo(
    () =>
      buildNavigationCommandResults({
        query,
        projects,
        threads,
        draftProjectIds,
      }),
    [draftProjectIds, projects, threads, query],
  );
  const isSearching = query.trim().length > 0;
  const hasResults = results.items.length > 0;
  const activeOptionId = hasResults ? `${listId}-option-${highlightedIndex}` : undefined;

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  useEffect(() => {
    setHighlightedIndex((current) => {
      if (results.items.length === 0) return 0;
      return Math.min(current, results.items.length - 1);
    });
  }, [results.items.length]);

  useLayoutEffect(() => {
    if (!open || !hasResults) return;
    optionRefs.current.get(highlightedIndex)?.scrollIntoView({ block: "nearest" });
  }, [hasResults, highlightedIndex, open]);

  const selectNavigationCommandItem = useCallback(
    (item: (typeof results.items)[number]) => {
      if (item.type === "thread") {
        void onSelectThread(item.id);
        return;
      }
      void onSelectProject(item.id);
    },
    [onSelectProject, onSelectThread],
  );

  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIndex((current) =>
          results.items.length === 0 ? 0 : Math.min(current + 1, results.items.length - 1),
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
        setHighlightedIndex(results.items.length === 0 ? 0 : results.items.length - 1);
        return;
      }

      if (event.key === "Enter") {
        const item = results.items[highlightedIndex];
        if (!item) return;
        event.preventDefault();
        selectNavigationCommandItem(item);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
      }
    },
    [highlightedIndex, onOpenChange, results.items, selectNavigationCommandItem],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup
        aria-label="Navigation command menu"
        backdropClassName="duration-75"
        className="h-[min(32rem,72vh)] max-h-[min(32rem,72vh)] transition-[scale,opacity] duration-75 ease-out data-ending-style:translate-y-0 data-starting-style:translate-y-0 data-nested:data-ending-style:translate-y-0 data-nested:data-starting-style:translate-y-0"
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
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
                onKeyDown={handleInputKeyDown}
                placeholder={isSearching ? "Search threads and projects..." : "Search threads..."}
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
                data-slot="command-list"
                role="listbox"
              >
                {hasResults ? null : (
                  <div
                    className="flex min-h-full items-center justify-center not-empty:py-6 text-center text-base text-muted-foreground sm:text-sm"
                    data-slot="command-empty"
                  >
                    {isSearching ? "No matching threads or projects." : "No recent threads."}
                  </div>
                )}

                {results.items.map((item, index) => {
                  const thread = item.type === "thread" ? (threadsById.get(item.id) ?? null) : null;
                  const resolvedThreadStatus =
                    thread === null
                      ? null
                      : resolveThreadStatusPill({
                          thread: {
                            ...thread,
                            lastVisitedAt: threadLastVisitedAtById[thread.id],
                          },
                          hasPendingApprovals: derivePendingApprovals(thread.activities).length > 0,
                          hasPendingUserInput:
                            derivePendingUserInputs(thread.activities).length > 0,
                        });
                  const threadStatus = isActionableThreadStatus(resolvedThreadStatus)
                    ? resolvedThreadStatus
                    : null;
                  const isHighlighted = index === highlightedIndex;

                  return (
                    <button
                      key={`${item.type}:${item.id}`}
                      ref={(element) => {
                        if (element) {
                          optionRefs.current.set(index, element);
                        } else {
                          optionRefs.current.delete(index);
                        }
                      }}
                      id={`${listId}-option-${index}`}
                      aria-selected={isHighlighted}
                      className="flex min-h-8 w-full cursor-pointer select-none items-center gap-3 rounded-sm px-2 py-2 text-start text-base outline-none transition-colors hover:bg-accent/70 hover:text-accent-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground sm:min-h-7 sm:text-sm"
                      data-highlighted={isHighlighted ? "true" : undefined}
                      data-slot="command-item"
                      onClick={() => {
                        selectNavigationCommandItem(item);
                      }}
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      role="option"
                      type="button"
                    >
                      {item.type === "thread" ? (
                        <MessageSquareTextIcon className="size-4 shrink-0 text-muted-foreground/80" />
                      ) : (
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground/80" />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          {item.type === "thread" && threadStatus ? (
                            <span
                              className={cn(
                                "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 font-medium text-[11px]",
                                threadStatus.colorClass,
                              )}
                            >
                              <span
                                className={cn(
                                  "size-1.5 rounded-full",
                                  threadStatus.dotClass,
                                  threadStatus.pulse && "animate-pulse",
                                )}
                              />
                              <span>{threadStatus.label}</span>
                            </span>
                          ) : null}
                          <span className="truncate font-medium text-foreground text-sm">
                            {item.type === "thread" ? item.title : item.name}
                          </span>
                        </span>
                        <span className="truncate text-muted-foreground text-xs">
                          {item.type === "thread" ? item.projectName : item.cwd}
                        </span>
                      </span>
                      {item.type === "thread" ? (
                        <span className="flex shrink-0 items-start self-stretch pt-0.5">
                          <CommandShortcut className="tracking-normal">
                            {formatRelativeTime(item.recencyAt)}
                          </CommandShortcut>
                        </span>
                      ) : (
                        <span
                          className={cn(
                            "shrink-0 rounded-full border px-2 py-0.5 font-medium text-[11px]",
                            item.hasDraft
                              ? "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
                              : "border-border bg-muted/72 text-muted-foreground",
                          )}
                        >
                          {getProjectCommandActionLabel(item.hasDraft)}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </ScrollArea>
          </CommandPanel>
          <CommandFooter>
            <span className="flex items-center gap-1.5">
              <CommandShortcut>Enter</CommandShortcut>
              <span>Open</span>
            </span>
            <span className="flex items-center gap-1.5">
              <CommandShortcut>Esc</CommandShortcut>
              <span>Close</span>
            </span>
          </CommandFooter>
        </div>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
