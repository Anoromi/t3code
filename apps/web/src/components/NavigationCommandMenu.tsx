import { FolderIcon, MessageSquareTextIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from "./ui/command";

export function NavigationCommandMenu(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: readonly Project[];
  threads: readonly Thread[];
  draftProjectIds: ReadonlySet<ProjectId>;
  onSelectThread: (threadId: ThreadId) => void | Promise<void>;
  onSelectProject: (projectId: ProjectId) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const threadLastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);

  useEffect(() => {
    if (props.open) return;
    setQuery("");
  }, [props.open]);

  const threadsById = useMemo(
    () => new Map(props.threads.map((thread) => [thread.id, thread] as const)),
    [props.threads],
  );

  const results = useMemo(
    () =>
      buildNavigationCommandResults({
        query,
        projects: props.projects,
        threads: props.threads,
        draftProjectIds: props.draftProjectIds,
      }),
    [props.draftProjectIds, props.projects, props.threads, query],
  );
  const isSearching = query.trim().length > 0;
  const hasResults = results.items.length > 0;

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup
        aria-label="Navigation command menu"
        backdropClassName="duration-75"
        className="h-[min(32rem,72vh)] max-h-[min(32rem,72vh)] transition-[scale,opacity] duration-75 ease-out data-ending-style:translate-y-0 data-starting-style:translate-y-0 data-nested:data-ending-style:translate-y-0 data-nested:data-starting-style:translate-y-0"
      >
        <Command mode="none">
          <div className="flex h-full min-h-0 flex-col">
            <CommandInput
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
              placeholder={isSearching ? "Search threads and projects..." : "Search threads..."}
            />
            <CommandPanel className="flex-1 min-h-0">
              <CommandList className="h-full max-h-none">
                {hasResults ? null : (
                  <CommandEmpty className="flex min-h-full items-center justify-center">
                    {isSearching ? "No matching threads or projects." : "No recent threads."}
                  </CommandEmpty>
                )}

                {results.items.map((item) => {
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

                  return (
                    <CommandItem
                      key={`${item.type}:${item.id}`}
                      value={`${item.type}:${item.id}`}
                      className="cursor-pointer gap-3 py-2"
                      onMouseDown={(event) => {
                        event.preventDefault();
                      }}
                      onClick={() => {
                        if (item.type === "thread") {
                          void props.onSelectThread(item.id);
                          return;
                        }
                        void props.onSelectProject(item.id);
                      }}
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
                    </CommandItem>
                  );
                })}
              </CommandList>
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
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  );
}
