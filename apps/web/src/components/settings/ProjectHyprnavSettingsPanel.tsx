import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DEFAULT_PROJECT_HYPRNAV_SETTINGS,
  type EnvironmentId,
  type ProjectHyprnavAction,
  type ProjectHyprnavBinding,
  type ProjectHyprnavScope,
  type ProjectHyprnavSettings,
  type ProjectId,
} from "@t3tools/contracts";
import type { GroupedProjectHyprnavMode, GroupedProjectHyprnavState } from "@t3tools/contracts";
import {
  CommandIcon,
  PlusIcon,
  StarIcon,
  TerminalSquareIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";

import { readEnvironmentApi } from "../../environmentApi";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import {
  buildProjectHyprnavSyncJobs,
  computeRemovedHyprnavBindings,
  findHyprnavActionLabel,
  findHyprnavScopeLabel,
  HYPRNAV_ACTION_ROWS,
  HYPRNAV_SCOPE_ROWS,
  hyprnavScopeSlotKey,
  projectHyprnavNeedsCorkdiffConnection,
  validateProjectHyprnavSettings,
} from "../../hyprnavSettings";
import { resolveExternalCorkdiffConnection } from "../../lib/externalCorkdiff";
import { cn, newCommandId } from "../../lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "../../logicalProject";
import { useServerAvailableEditors } from "../../rpc/serverState";
import {
  selectProjectsAcrossEnvironments,
  selectThreadShellsAcrossEnvironments,
  useStore,
} from "../../store";
import type { Project } from "../../types";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

type HyprnavDraftBinding = {
  id: string;
  slot: string;
  scope: ProjectHyprnavScope;
  action: ProjectHyprnavAction;
  command: string;
};

type HyprnavDraft = HyprnavDraftBinding[];

type DraftEvaluation = {
  parsed: {
    settings: ProjectHyprnavSettings;
    invalidSlotBindingIds: string[];
  };
  validation: ReturnType<typeof validateProjectHyprnavSettings>;
  duplicateScopedSlotKeySet: Set<string>;
  hasValidationError: boolean;
};

const ACTION_ICONS = {
  "worktree-terminal": TerminalSquareIcon,
  "open-favorite-editor": StarIcon,
  "shell-command": CommandIcon,
} satisfies Record<ProjectHyprnavAction, LucideIcon>;

function makeCustomBindingId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneDraft(draft: HyprnavDraft): HyprnavDraft {
  return draft.map((binding) => ({ ...binding }));
}

function cloneDraftRecord(record: Record<string, HyprnavDraft>): Record<string, HyprnavDraft> {
  return Object.fromEntries(Object.entries(record).map(([key, draft]) => [key, cloneDraft(draft)]));
}

function draftBindingFromSettings(binding: ProjectHyprnavBinding): HyprnavDraftBinding {
  return {
    id: binding.id,
    slot: String(binding.slot),
    scope: binding.scope,
    action: binding.action,
    command: binding.action === "shell-command" ? binding.command : "",
  };
}

function draftFromSettings(settings: ProjectHyprnavSettings): HyprnavDraft {
  return settings.bindings.map(draftBindingFromSettings);
}

function defaultDraftBinding(id: string): HyprnavDraftBinding | null {
  const binding = DEFAULT_PROJECT_HYPRNAV_SETTINGS.bindings.find(
    (candidate) => candidate.id === id,
  );
  return binding ? draftBindingFromSettings(binding) : null;
}

function restoreDraftBinding(
  draft: HyprnavDraft,
  bindingId: string,
  sourceSettings: ProjectHyprnavSettings,
): HyprnavDraft {
  const defaultBinding = defaultDraftBinding(bindingId);
  if (defaultBinding) {
    return draft.map((binding) => (binding.id === bindingId ? defaultBinding : binding));
  }

  const savedBinding = sourceSettings.bindings.find((binding) => binding.id === bindingId);
  if (savedBinding) {
    const restored = draftBindingFromSettings(savedBinding);
    return draft.map((binding) => (binding.id === bindingId ? restored : binding));
  }

  return draft.map((binding) =>
    binding.id === bindingId
      ? {
          id: bindingId,
          slot: binding.slot,
          scope: "worktree",
          action: "shell-command",
          command: "",
        }
      : binding,
  );
}

function findNextSlot(draft: HyprnavDraft): number {
  const usedSlots = new Set(
    draft.flatMap((binding) => {
      const slot = Number(binding.slot);
      return Number.isInteger(slot) && slot > 0 ? [slot] : [];
    }),
  );
  for (let slot = 1; ; slot += 1) {
    if (!usedSlots.has(slot)) {
      return slot;
    }
  }
}

function describeManagedBinding(action: ProjectHyprnavAction, scope: ProjectHyprnavScope): string {
  switch (action) {
    case "worktree-terminal":
      return scope === "project"
        ? "Ghostty + tmux in the project root"
        : "Ghostty + tmux in the target worktree";
    case "open-favorite-editor":
      return scope === "project"
        ? "Preferred editor in the project root"
        : "Preferred editor in the target worktree";
    case "shell-command":
      return "";
  }
}

function parseDraft(draft: HyprnavDraft): {
  settings: ProjectHyprnavSettings;
  invalidSlotBindingIds: string[];
} {
  const invalidSlotBindingIds: string[] = [];
  const bindings: ProjectHyprnavBinding[] = [];
  for (const binding of draft) {
    const rawSlot = binding.slot.trim();
    const slot = Number(rawSlot);
    if (rawSlot.length === 0 || !Number.isInteger(slot) || slot <= 0) {
      invalidSlotBindingIds.push(binding.id);
      continue;
    }

    if (binding.action === "shell-command") {
      bindings.push({
        id: binding.id,
        slot,
        scope: binding.scope,
        action: "shell-command",
        command: binding.command.trim(),
      });
      continue;
    }

    bindings.push({
      id: binding.id,
      slot,
      scope: binding.scope,
      action: binding.action,
    });
  }

  return {
    settings: { bindings },
    invalidSlotBindingIds,
  };
}

function evaluateDraft(draft: HyprnavDraft): DraftEvaluation {
  const parsed = parseDraft(draft);
  const validation = validateProjectHyprnavSettings(parsed.settings);
  return {
    parsed,
    validation,
    duplicateScopedSlotKeySet: new Set(
      validation.duplicateScopedSlots.map((binding) =>
        hyprnavScopeSlotKey(binding.scope, binding.slot),
      ),
    ),
    hasValidationError:
      parsed.invalidSlotBindingIds.length > 0 ||
      validation.duplicateScopedSlots.length > 0 ||
      validation.emptyShellCommandBindingIds.length > 0,
  };
}

function copyDraftToProjects(
  projects: readonly Project[],
  draft: HyprnavDraft,
): Record<string, HyprnavDraft> {
  return Object.fromEntries(
    projects.map((project) => [derivePhysicalProjectKey(project), cloneDraft(draft)]),
  );
}

function resolveDefaultProjectKey(input: {
  projects: readonly Project[];
  preferredPhysicalKey: string | undefined;
  representativePhysicalKey: string | null;
}): string | null {
  const knownPhysicalKeys = new Set(
    input.projects.map((project) => derivePhysicalProjectKey(project)),
  );
  if (input.preferredPhysicalKey && knownPhysicalKeys.has(input.preferredPhysicalKey)) {
    return input.preferredPhysicalKey;
  }
  if (input.representativePhysicalKey && knownPhysicalKeys.has(input.representativePhysicalKey)) {
    return input.representativePhysicalKey;
  }
  return input.projects.length > 0 ? derivePhysicalProjectKey(input.projects[0]!) : null;
}

function makeGroupedProjectStateRecord(input: {
  current: Record<string, GroupedProjectHyprnavState>;
  logicalProjectKey: string;
  mode: GroupedProjectHyprnavMode;
  defaultProjectKey: string | null;
}): Record<string, GroupedProjectHyprnavState> {
  const next = { ...input.current };
  if (input.mode === "same") {
    delete next[input.logicalProjectKey];
    return next;
  }
  next[input.logicalProjectKey] = input.defaultProjectKey
    ? { mode: "separate", defaultProjectKey: input.defaultProjectKey }
    : { mode: "separate" };
  return next;
}

function HyprnavActionAutocomplete({
  action,
  disabled,
  onChange,
}: {
  action: ProjectHyprnavAction;
  disabled: boolean;
  onChange: (action: ProjectHyprnavAction) => void;
}) {
  const selectedLabel = findHyprnavActionLabel(action);
  const [query, setQuery] = useState(selectedLabel);

  useEffect(() => {
    setQuery(selectedLabel);
  }, [selectedLabel]);

  return (
    <Autocomplete
      items={HYPRNAV_ACTION_ROWS}
      itemToStringValue={(item) => item.label}
      mode="list"
      openOnInputClick
      value={query}
      onValueChange={setQuery}
    >
      <AutocompleteInput
        disabled={disabled}
        showTrigger
        size="sm"
        onBlur={() => setQuery(selectedLabel)}
      />
      <AutocompletePopup>
        <AutocompleteList>
          {HYPRNAV_ACTION_ROWS.map(({ key, label }, index) => {
            const Icon = ACTION_ICONS[key];
            return (
              <AutocompleteItem
                key={key}
                index={index}
                value={{ key, label }}
                onClick={() => {
                  onChange(key);
                  setQuery(label);
                }}
              >
                <Icon className="mr-2 size-3.5 text-muted-foreground" />
                {label}
              </AutocompleteItem>
            );
          })}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  );
}

function HyprnavScopeAutocomplete({
  scope,
  disabled,
  onChange,
}: {
  scope: ProjectHyprnavScope;
  disabled: boolean;
  onChange: (scope: ProjectHyprnavScope) => void;
}) {
  const selectedLabel = findHyprnavScopeLabel(scope);
  const [query, setQuery] = useState(selectedLabel);

  useEffect(() => {
    setQuery(selectedLabel);
  }, [selectedLabel]);

  return (
    <Autocomplete
      items={HYPRNAV_SCOPE_ROWS}
      itemToStringValue={(item) => item.label}
      mode="list"
      openOnInputClick
      value={query}
      onValueChange={setQuery}
    >
      <AutocompleteInput
        disabled={disabled}
        showTrigger
        size="sm"
        onBlur={() => setQuery(selectedLabel)}
      />
      <AutocompletePopup>
        <AutocompleteList>
          {HYPRNAV_SCOPE_ROWS.map(({ key, label }, index) => (
            <AutocompleteItem
              key={key}
              index={index}
              value={{ key, label }}
              onClick={() => {
                onChange(key);
                setQuery(label);
              }}
            >
              {label}
            </AutocompleteItem>
          ))}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  );
}

function HyprnavBindingsEditor({
  title,
  description,
  draft,
  evaluation,
  busy,
  onUpdateBinding,
  onRestoreBinding,
  onAddBinding,
  onRemoveBinding,
}: {
  title: string;
  description: string;
  draft: HyprnavDraft;
  evaluation: DraftEvaluation;
  busy: boolean;
  onUpdateBinding: (
    bindingId: string,
    update: (binding: HyprnavDraftBinding) => HyprnavDraftBinding,
  ) => void;
  onRestoreBinding: (bindingId: string) => void;
  onAddBinding: () => void;
  onRemoveBinding: (bindingId: string) => void;
}) {
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="flex flex-col gap-3 border-b border-border/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button size="xs" variant="outline" disabled={busy} onClick={onAddBinding}>
          <PlusIcon className="size-3.5" />
          Add slot
        </Button>
      </div>

      {draft.map((binding) => {
        const parsedSlot = Number(binding.slot);
        const slotInvalid = evaluation.parsed.invalidSlotBindingIds.includes(binding.id);
        const duplicate =
          Number.isInteger(parsedSlot) &&
          evaluation.duplicateScopedSlotKeySet.has(hyprnavScopeSlotKey(binding.scope, parsedSlot));
        const shellCommandEmpty = evaluation.validation.emptyShellCommandBindingIds.includes(
          binding.id,
        );
        const rowInvalid = slotInvalid || duplicate || shellCommandEmpty;

        return (
          <div
            key={binding.id}
            className={cn(
              "border-b border-border/60 px-4 py-3 last:border-b-0 lg:px-5",
              rowInvalid && "bg-destructive/4",
            )}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[5.5rem_minmax(0,1fr)] lg:grid-cols-[5.5rem_minmax(12rem,1fr)_minmax(12rem,1fr)_auto] lg:items-start">
              <div className="space-y-1 min-w-0">
                <p className="text-[11px] font-medium text-muted-foreground">Slot</p>
                <Input
                  aria-invalid={slotInvalid || duplicate}
                  disabled={busy}
                  inputMode="numeric"
                  size="sm"
                  value={binding.slot}
                  onChange={(event) =>
                    onUpdateBinding(binding.id, (current) => ({
                      ...current,
                      slot: event.target.value,
                    }))
                  }
                />
                {slotInvalid ? (
                  <p className="text-[11px] text-destructive">Use a positive whole number.</p>
                ) : duplicate ? (
                  <p className="text-[11px] text-destructive">
                    Already used for {findHyprnavScopeLabel(binding.scope).toLowerCase()}.
                  </p>
                ) : null}
              </div>

              <div className="space-y-1 min-w-0">
                <p className="text-[11px] font-medium text-muted-foreground">Scope</p>
                <HyprnavScopeAutocomplete
                  scope={binding.scope}
                  disabled={busy}
                  onChange={(scope) =>
                    onUpdateBinding(binding.id, (current) => ({
                      ...current,
                      scope,
                    }))
                  }
                />
              </div>

              <div className="space-y-1 min-w-0 sm:col-span-2 lg:col-span-1">
                <p className="text-[11px] font-medium text-muted-foreground">Action</p>
                <HyprnavActionAutocomplete
                  action={binding.action}
                  disabled={busy}
                  onChange={(action) =>
                    onUpdateBinding(binding.id, (current) => ({
                      ...current,
                      action,
                      command: action === "shell-command" ? current.command : "",
                    }))
                  }
                />
              </div>

              <div className="space-y-1 sm:col-span-2 lg:col-span-1 lg:min-w-[3rem]">
                <p className="text-[11px] font-medium text-transparent select-none" aria-hidden>
                  Actions
                </p>
                <div className="flex h-7 items-center justify-end gap-1">
                  <SettingResetButton
                    label={`${findHyprnavActionLabel(binding.action)} slot`}
                    onClick={() => onRestoreBinding(binding.id)}
                  />
                  <Button
                    aria-label={`Remove ${findHyprnavActionLabel(binding.action)} slot`}
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={busy}
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => onRemoveBinding(binding.id)}
                  >
                    <Trash2Icon className="size-3" />
                  </Button>
                </div>
              </div>
            </div>

            <div className="mt-3 space-y-1 min-w-0">
              <p className="text-[11px] font-medium text-muted-foreground">Command</p>
              {binding.action === "shell-command" ? (
                <>
                  <Input
                    aria-invalid={shellCommandEmpty}
                    className="w-full"
                    disabled={busy}
                    placeholder="sh command"
                    size="sm"
                    value={binding.command}
                    onChange={(event) =>
                      onUpdateBinding(binding.id, (current) => ({
                        ...current,
                        command: event.target.value,
                      }))
                    }
                  />
                  <p className="max-w-3xl text-[11px] leading-5 text-muted-foreground">
                    Available placeholders: {"{projectRoot}"}, {"{worktreePath}"}, {"{threadId}"},{" "}
                    {"{corkdiffLaunchCommand}"}
                  </p>
                </>
              ) : (
                <div
                  className="flex min-h-9 items-center rounded-md border border-border/60 bg-muted/20 px-3 text-sm leading-6 text-muted-foreground"
                  title={describeManagedBinding(binding.action, binding.scope)}
                >
                  {describeManagedBinding(binding.action, binding.scope)}
                </div>
              )}
              {shellCommandEmpty ? (
                <p className="text-[11px] text-destructive">Command is required.</p>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ProjectHyprnavSettingsPanel({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));
  const threadShells = useStore(useShallow(selectThreadShellsAcrossEnvironments));
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const availableEditors = useServerAvailableEditors();
  const localEnvironmentId = usePrimaryEnvironmentId();

  const projectGroupingSettings = useMemo<ProjectGroupingSettings>(
    () => ({
      sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
      sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
    }),
    [settings.sidebarProjectGroupingMode, settings.sidebarProjectGroupingOverrides],
  );

  const project = useMemo(
    () =>
      projects.find(
        (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
      ) ?? null,
    [environmentId, projectId, projects],
  );

  const logicalProjectKey = useMemo(
    () => (project ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings) : null),
    [project, projectGroupingSettings],
  );

  const groupedProjects = useMemo(() => {
    if (!project || !logicalProjectKey) {
      return [] as Project[];
    }

    return projects
      .filter(
        (candidate) =>
          deriveLogicalProjectKeyFromSettings(candidate, projectGroupingSettings) ===
          logicalProjectKey,
      )
      .toSorted((left, right) => {
        const leftIsLocal =
          localEnvironmentId !== null && left.environmentId === localEnvironmentId;
        const rightIsLocal =
          localEnvironmentId !== null && right.environmentId === localEnvironmentId;
        if (leftIsLocal !== rightIsLocal) {
          return leftIsLocal ? -1 : 1;
        }
        if (
          left.environmentId === environmentId &&
          left.id === projectId &&
          (right.environmentId !== environmentId || right.id !== projectId)
        ) {
          return -1;
        }
        if (
          right.environmentId === environmentId &&
          right.id === projectId &&
          (left.environmentId !== environmentId || left.id !== projectId)
        ) {
          return 1;
        }
        return left.cwd.localeCompare(right.cwd);
      });
  }, [
    environmentId,
    localEnvironmentId,
    logicalProjectKey,
    project,
    projectGroupingSettings,
    projectId,
    projects,
  ]);

  const representativeProject = useMemo(
    () =>
      groupedProjects.find(
        (candidate) =>
          localEnvironmentId !== null && candidate.environmentId === localEnvironmentId,
      ) ??
      groupedProjects.find(
        (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
      ) ??
      groupedProjects[0] ??
      null,
    [environmentId, groupedProjects, localEnvironmentId, projectId],
  );

  const initialPanelState = useMemo(() => {
    if (!representativeProject) {
      return null;
    }

    const groupedState = logicalProjectKey
      ? settings.groupedProjectHyprnavStateByLogicalProjectKey[logicalProjectKey]
      : undefined;
    const representativePhysicalKey = derivePhysicalProjectKey(representativeProject);
    const sharedDraft = draftFromSettings(representativeProject.hyprnav);
    const mode: GroupedProjectHyprnavMode =
      groupedProjects.length > 1 && groupedState?.mode === "separate" ? "separate" : "same";

    return {
      mode,
      sharedDraft,
      projectDraftsByPhysicalKey:
        mode === "separate"
          ? Object.fromEntries(
              groupedProjects.map((candidate) => [
                derivePhysicalProjectKey(candidate),
                draftFromSettings(candidate.hyprnav),
              ]),
            )
          : copyDraftToProjects(groupedProjects, sharedDraft),
      defaultPhysicalProjectKey: resolveDefaultProjectKey({
        projects: groupedProjects,
        preferredPhysicalKey: groupedState?.defaultProjectKey,
        representativePhysicalKey,
      }),
    };
  }, [
    groupedProjects,
    logicalProjectKey,
    representativeProject,
    settings.groupedProjectHyprnavStateByLogicalProjectKey,
  ]);

  const [editorMode, setEditorMode] = useState<GroupedProjectHyprnavMode>("same");
  const [sharedDraft, setSharedDraft] = useState<HyprnavDraft | null>(null);
  const [projectDraftsByPhysicalKey, setProjectDraftsByPhysicalKey] = useState<
    Record<string, HyprnavDraft>
  >({});
  const [defaultPhysicalProjectKey, setDefaultPhysicalProjectKey] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    if (!initialPanelState) {
      setEditorMode("same");
      setSharedDraft(null);
      setProjectDraftsByPhysicalKey({});
      setDefaultPhysicalProjectKey(null);
      return;
    }
    setEditorMode(initialPanelState.mode);
    setSharedDraft(cloneDraft(initialPanelState.sharedDraft));
    setProjectDraftsByPhysicalKey(cloneDraftRecord(initialPanelState.projectDraftsByPhysicalKey));
    setDefaultPhysicalProjectKey(initialPanelState.defaultPhysicalProjectKey);
  }, [initialPanelState]);

  const sharedEvaluation = useMemo(
    () => (sharedDraft ? evaluateDraft(sharedDraft) : null),
    [sharedDraft],
  );

  const projectEvaluationsByPhysicalKey = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(projectDraftsByPhysicalKey).map(([physicalKey, draft]) => [
          physicalKey,
          evaluateDraft(draft),
        ]),
      ),
    [projectDraftsByPhysicalKey],
  );

  const groupEditors = useMemo(
    () =>
      groupedProjects.map((candidate) => {
        const physicalProjectKey = derivePhysicalProjectKey(candidate);
        const draft =
          projectDraftsByPhysicalKey[physicalProjectKey] ?? draftFromSettings(candidate.hyprnav);
        return {
          project: candidate,
          physicalProjectKey,
          scopedProjectKey: scopedProjectKey(
            scopeProjectRef(candidate.environmentId, candidate.id),
          ),
          draft,
          evaluation: projectEvaluationsByPhysicalKey[physicalProjectKey] ?? evaluateDraft(draft),
        };
      }),
    [groupedProjects, projectDraftsByPhysicalKey, projectEvaluationsByPhysicalKey],
  );

  const hasValidationError =
    editorMode === "same"
      ? sharedEvaluation === null || sharedEvaluation.hasValidationError
      : groupEditors.some((editor) => editor.evaluation.hasValidationError);

  const busy = isSaving || isApplying;

  const updateSharedDraft = useCallback(
    (bindingId: string, update: (binding: HyprnavDraftBinding) => HyprnavDraftBinding) => {
      setSharedDraft((current) =>
        current
          ? current.map((binding) => (binding.id === bindingId ? update(binding) : binding))
          : current,
      );
    },
    [],
  );

  const updateProjectDraft = useCallback(
    (
      physicalProjectKey: string,
      bindingId: string,
      update: (binding: HyprnavDraftBinding) => HyprnavDraftBinding,
    ) => {
      setProjectDraftsByPhysicalKey((current) => {
        const draft = current[physicalProjectKey];
        if (!draft) {
          return current;
        }
        return {
          ...current,
          [physicalProjectKey]: draft.map((binding) =>
            binding.id === bindingId ? update(binding) : binding,
          ),
        };
      });
    },
    [],
  );

  const addSharedBinding = useCallback(() => {
    setSharedDraft((current) => {
      const nextDraft = current ?? [];
      return [
        ...nextDraft,
        {
          id: makeCustomBindingId(),
          slot: String(findNextSlot(nextDraft)),
          scope: "worktree",
          action: "shell-command",
          command: "",
        },
      ];
    });
  }, []);

  const addProjectBinding = useCallback((physicalProjectKey: string) => {
    setProjectDraftsByPhysicalKey((current) => {
      const nextDraft = current[physicalProjectKey] ?? [];
      return {
        ...current,
        [physicalProjectKey]: [
          ...nextDraft,
          {
            id: makeCustomBindingId(),
            slot: String(findNextSlot(nextDraft)),
            scope: "worktree",
            action: "shell-command",
            command: "",
          },
        ],
      };
    });
  }, []);

  const removeSharedBinding = useCallback((bindingId: string) => {
    setSharedDraft((current) =>
      current ? current.filter((binding) => binding.id !== bindingId) : current,
    );
  }, []);

  const removeProjectBinding = useCallback((physicalProjectKey: string, bindingId: string) => {
    setProjectDraftsByPhysicalKey((current) => {
      const draft = current[physicalProjectKey];
      if (!draft) {
        return current;
      }
      return {
        ...current,
        [physicalProjectKey]: draft.filter((binding) => binding.id !== bindingId),
      };
    });
  }, []);

  const restoreSharedBinding = useCallback(
    (bindingId: string) => {
      if (!representativeProject) {
        return;
      }
      setSharedDraft((current) =>
        current ? restoreDraftBinding(current, bindingId, representativeProject.hyprnav) : current,
      );
    },
    [representativeProject],
  );

  const restoreProjectBinding = useCallback(
    (physicalProjectKey: string, bindingId: string) => {
      const sourceProject = groupedProjects.find(
        (candidate) => derivePhysicalProjectKey(candidate) === physicalProjectKey,
      );
      if (!sourceProject) {
        return;
      }
      setProjectDraftsByPhysicalKey((current) => {
        const draft = current[physicalProjectKey];
        if (!draft) {
          return current;
        }
        return {
          ...current,
          [physicalProjectKey]: restoreDraftBinding(draft, bindingId, sourceProject.hyprnav),
        };
      });
    },
    [groupedProjects],
  );

  const separatePerProject = useCallback(() => {
    if (!sharedDraft) {
      return;
    }
    const fallbackDefaultKey = resolveDefaultProjectKey({
      projects: groupedProjects,
      preferredPhysicalKey: defaultPhysicalProjectKey ?? undefined,
      representativePhysicalKey: representativeProject
        ? derivePhysicalProjectKey(representativeProject)
        : null,
    });
    setEditorMode("separate");
    setProjectDraftsByPhysicalKey(copyDraftToProjects(groupedProjects, sharedDraft));
    setDefaultPhysicalProjectKey(fallbackDefaultKey);
  }, [defaultPhysicalProjectKey, groupedProjects, representativeProject, sharedDraft]);

  const makeDefaultProject = useCallback(
    (physicalProjectKey: string) => {
      const sourceDraft = projectDraftsByPhysicalKey[physicalProjectKey];
      if (!sourceDraft) {
        return;
      }
      setDefaultPhysicalProjectKey(physicalProjectKey);
      setSharedDraft(cloneDraft(sourceDraft));
      setProjectDraftsByPhysicalKey(copyDraftToProjects(groupedProjects, sourceDraft));
    },
    [groupedProjects, projectDraftsByPhysicalKey],
  );

  const save = useCallback(async () => {
    if (!project || !logicalProjectKey || groupedProjects.length === 0 || hasValidationError) {
      return;
    }

    const nextSettingsByPhysicalKey = new Map<string, ProjectHyprnavSettings>();
    if (editorMode === "same") {
      if (!sharedEvaluation) {
        return;
      }
      for (const candidate of groupedProjects) {
        nextSettingsByPhysicalKey.set(
          derivePhysicalProjectKey(candidate),
          sharedEvaluation.parsed.settings,
        );
      }
    } else {
      for (const editor of groupEditors) {
        nextSettingsByPhysicalKey.set(editor.physicalProjectKey, editor.evaluation.parsed.settings);
      }
    }

    setIsSaving(true);
    try {
      for (const candidate of groupedProjects) {
        const api = readEnvironmentApi(candidate.environmentId);
        if (!api) {
          throw new Error(`Environment unavailable for ${candidate.cwd}.`);
        }
        await api.orchestration.dispatchCommand({
          type: "project.meta.update",
          commandId: newCommandId(),
          projectId: candidate.id,
          hyprnav: nextSettingsByPhysicalKey.get(derivePhysicalProjectKey(candidate))!,
        });
      }

      const nextGroupedProjectState = makeGroupedProjectStateRecord({
        current: settings.groupedProjectHyprnavStateByLogicalProjectKey,
        logicalProjectKey,
        mode: groupedProjects.length > 1 ? editorMode : "same",
        defaultProjectKey:
          groupedProjects.length > 1 && editorMode === "separate"
            ? defaultPhysicalProjectKey
            : null,
      });
      updateSettings({
        groupedProjectHyprnavStateByLogicalProjectKey: nextGroupedProjectState,
      });

      const syncHyprnavEnvironment = window.desktopBridge?.syncHyprnavEnvironment;
      const localBaseProjects = groupedProjects.filter(
        (candidate) =>
          localEnvironmentId !== null && candidate.environmentId === localEnvironmentId,
      );
      const localProjects = localBaseProjects.map((candidate) => ({
        ...candidate,
        hyprnav: nextSettingsByPhysicalKey.get(derivePhysicalProjectKey(candidate))!,
      }));
      const canApplyLocally =
        syncHyprnavEnvironment && localEnvironmentId !== null && localProjects.length > 0;

      if (canApplyLocally) {
        setIsApplying(true);
        const needsPreferredEditor = localProjects.some((candidate) =>
          candidate.hyprnav.bindings.some((binding) => binding.action === "open-favorite-editor"),
        );
        const preferredEditor = needsPreferredEditor
          ? resolveAndPersistPreferredEditor(availableEditors)
          : null;
        const clearBindingsByProjectKey = new Map(
          localBaseProjects.map((candidate) => [
            scopedProjectKey(scopeProjectRef(candidate.environmentId, candidate.id)),
            computeRemovedHyprnavBindings(
              candidate.hyprnav,
              nextSettingsByPhysicalKey.get(derivePhysicalProjectKey(candidate))!,
            ),
          ]),
        );

        const jobs = buildProjectHyprnavSyncJobs({
          localEnvironmentId,
          projects: localProjects,
          threadShells: threadShells.filter((threadShell) =>
            localProjects.some(
              (candidate) =>
                candidate.environmentId === threadShell.environmentId &&
                candidate.id === threadShell.projectId,
            ),
          ),
          activeThread: null,
          clearBindingsByProjectKey,
        });

        const needsCorkdiffConnection =
          localProjects.some((candidate) =>
            projectHyprnavNeedsCorkdiffConnection(candidate.hyprnav),
          ) && jobs.some((job) => job.threadId);
        const corkdiffConnection = needsCorkdiffConnection
          ? await (async () => {
              const bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap() ?? null;
              const bridgeWsUrl = bootstrap?.wsBaseUrl ?? null;
              if (!bridgeWsUrl) {
                throw new Error("Desktop websocket URL is unavailable.");
              }
              return await resolveExternalCorkdiffConnection({
                wsBaseUrl: bridgeWsUrl,
                httpBaseUrl: bootstrap?.httpBaseUrl ?? null,
              });
            })()
          : null;

        for (const job of jobs) {
          const result = await syncHyprnavEnvironment({
            projectRoot: job.projectRoot,
            worktreePath: job.worktreePath,
            threadId: job.threadId,
            hyprnav: job.hyprnav,
            preferredEditor,
            clearBindings: job.clearBindings,
            corkdiffConnection,
            lock: job.lock,
          });
          if (result.status !== "ok") {
            toastManager.add({
              type: result.status === "unavailable" ? "warning" : "error",
              title: "Hyprnav was not applied",
              description: result.message ?? "Hyprnav could not apply the project settings.",
            });
            return;
          }
        }
      }

      toastManager.add({
        type: "success",
        title: canApplyLocally ? "Project settings saved and applied" : "Project settings saved",
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to save project settings",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setIsSaving(false);
      setIsApplying(false);
    }
  }, [
    availableEditors,
    defaultPhysicalProjectKey,
    editorMode,
    groupEditors,
    groupedProjects,
    hasValidationError,
    localEnvironmentId,
    logicalProjectKey,
    project,
    settings.groupedProjectHyprnavStateByLogicalProjectKey,
    sharedEvaluation,
    threadShells,
    updateSettings,
  ]);

  if (!project || !sharedDraft || !representativeProject) {
    return (
      <SettingsPageContainer width="wide">
        <SettingsSection title="Project">
          <SettingsRow
            title="Project not found"
            description="The selected project is not available in this environment."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection title="Projects">
        <SettingsRow
          title="Group"
          description={
            groupedProjects.length > 1
              ? `${groupedProjects.length} projects share this sidebar entry.`
              : "This sidebar entry has one project."
          }
          status={<span className="break-all font-mono">{logicalProjectKey ?? project.cwd}</span>}
        />
        {groupedProjects.length > 1 ? (
          <SettingsRow
            title="Editing mode"
            description={
              editorMode === "same"
                ? "One Hyprnav configuration applies to every project in this list."
                : "Each project keeps its own editor. Make default copies one project's commands to the full list."
            }
            control={
              editorMode === "same" ? (
                <Select
                  value={editorMode}
                  onValueChange={() => {
                    separatePerProject();
                  }}
                >
                  <SelectTrigger
                    aria-label="Project Hyprnav editing mode"
                    className="w-44"
                    size="sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="same">Same settings</SelectItem>
                    <SelectItem value="separate">Separate per project</SelectItem>
                  </SelectPopup>
                </Select>
              ) : (
                <span className="text-sm font-medium text-foreground">Separate per project</span>
              )
            }
          />
        ) : null}
        {groupedProjects.map((candidate) => {
          const physicalProjectKey = derivePhysicalProjectKey(candidate);
          const isDefault =
            editorMode === "separate" && defaultPhysicalProjectKey === physicalProjectKey;
          const isLocalProject =
            localEnvironmentId !== null && candidate.environmentId === localEnvironmentId;

          return (
            <SettingsRow
              key={physicalProjectKey}
              title={candidate.name}
              description={
                isLocalProject ? "Local project" : `Environment ${candidate.environmentId}`
              }
              status={<span className="break-all font-mono">{candidate.cwd}</span>}
              control={
                groupedProjects.length > 1 ? (
                  editorMode === "same" ? (
                    <Badge size="sm" variant="outline">
                      Shared
                    </Badge>
                  ) : isDefault ? (
                    <Badge size="sm" variant="outline">
                      Default
                    </Badge>
                  ) : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => makeDefaultProject(physicalProjectKey)}
                    >
                      Make default
                    </Button>
                  )
                ) : null
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection
        title="Hyprnav"
        headerAction={
          <Button size="xs" disabled={hasValidationError || busy} onClick={() => void save()}>
            {isApplying ? "Applying..." : isSaving ? "Saving..." : "Save and apply"}
          </Button>
        }
      >
        {editorMode === "same" ? (
          <HyprnavBindingsEditor
            title="Shared settings"
            description={
              groupedProjects.length > 1
                ? "Changes here apply to every project in this list."
                : "Changes here apply to this project."
            }
            draft={sharedDraft}
            evaluation={sharedEvaluation ?? evaluateDraft(sharedDraft)}
            busy={busy}
            onUpdateBinding={updateSharedDraft}
            onRestoreBinding={restoreSharedBinding}
            onAddBinding={addSharedBinding}
            onRemoveBinding={removeSharedBinding}
          />
        ) : (
          groupEditors.map((editor) => (
            <HyprnavBindingsEditor
              key={editor.physicalProjectKey}
              title={editor.project.name}
              description={editor.project.cwd}
              draft={editor.draft}
              evaluation={editor.evaluation}
              busy={busy}
              onUpdateBinding={(bindingId, update) =>
                updateProjectDraft(editor.physicalProjectKey, bindingId, update)
              }
              onRestoreBinding={(bindingId) =>
                restoreProjectBinding(editor.physicalProjectKey, bindingId)
              }
              onAddBinding={() => addProjectBinding(editor.physicalProjectKey)}
              onRemoveBinding={(bindingId) =>
                removeProjectBinding(editor.physicalProjectKey, bindingId)
              }
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
