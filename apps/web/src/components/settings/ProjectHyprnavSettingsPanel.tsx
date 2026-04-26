import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DEFAULT_PROJECT_HYPRNAV_SETTINGS,
  type EnvironmentId,
  type ProjectHyprnavAction,
  type ProjectHyprnavBinding,
  type ProjectHyprnavOverride,
  type ProjectHyprnavScope,
  type ProjectHyprnavSettings,
  type ProjectHyprnavWorkspaceTarget,
  type ProjectId,
} from "@t3tools/contracts";
import type { GroupedProjectHyprnavMode, GroupedProjectHyprnavState } from "@t3tools/contracts";
import {
  CommandIcon,
  MinusIcon,
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
  computeClearedHyprnavBindingNames,
  computeRemovedHyprnavBindings,
  findHyprnavActionLabel,
  findHyprnavScopeLabel,
  findHyprnavWorkspaceLabel,
  HYPRNAV_ACTION_ROWS,
  HYPRNAV_SCOPE_ROWS,
  HYPRNAV_WORKSPACE_ROWS,
  hyprnavScopeSlotKey,
  projectHyprnavNeedsCorkdiffConnection,
  projectUsesDefaultHyprnav,
  resolveProjectHyprnavSettings,
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
  workspaceMode: ProjectHyprnavWorkspaceTarget["mode"];
  workspaceId: string;
  name: string;
  action: ProjectHyprnavAction;
  command: string;
};

type HyprnavDraft = HyprnavDraftBinding[];

type DraftEvaluation = {
  parsed: {
    settings: ProjectHyprnavSettings;
    invalidSlotBindingIds: string[];
    invalidWorkspaceBindingIds: string[];
  };
  validation: ReturnType<typeof validateProjectHyprnavSettings>;
  duplicateScopedSlotKeySet: Set<string>;
  hasValidationError: boolean;
};

const ACTION_ICONS = {
  "worktree-terminal": TerminalSquareIcon,
  "open-favorite-editor": StarIcon,
  nothing: MinusIcon,
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
    workspaceMode: binding.workspace.mode,
    workspaceId: binding.workspace.mode === "absolute" ? String(binding.workspace.workspaceId) : "",
    name: binding.name ?? "",
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
          workspaceMode: "managed",
          workspaceId: "",
          name: "",
          action: "shell-command",
          command: "",
        }
      : binding,
  );
}

function hyprnavSettingsEqual(
  left: ProjectHyprnavSettings,
  right: ProjectHyprnavSettings,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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

function describeManagedBinding(
  action: ProjectHyprnavAction,
  scope: ProjectHyprnavScope,
  workspaceMode: ProjectHyprnavWorkspaceTarget["mode"],
  workspaceId: string,
): string {
  const locationDescription =
    workspaceMode === "absolute" && workspaceId.trim().length > 0
      ? ` on workspace ${workspaceId.trim()}`
      : "";
  switch (action) {
    case "worktree-terminal":
      return scope === "project"
        ? `Ghostty + tmux in the project root${locationDescription}`
        : `Ghostty + tmux in the target worktree${locationDescription}`;
    case "open-favorite-editor":
      return scope === "project"
        ? `Preferred editor in the project root${locationDescription}`
        : `Preferred editor in the target worktree${locationDescription}`;
    case "nothing":
      return `Reserve this slot without running a command${locationDescription}`;
    case "shell-command":
      return "";
  }
}

function parseDraft(draft: HyprnavDraft): {
  settings: ProjectHyprnavSettings;
  invalidSlotBindingIds: string[];
  invalidWorkspaceBindingIds: string[];
} {
  const invalidSlotBindingIds: string[] = [];
  const invalidWorkspaceBindingIds: string[] = [];
  const bindings: ProjectHyprnavBinding[] = [];
  for (const binding of draft) {
    const rawSlot = binding.slot.trim();
    const slot = Number(rawSlot);
    if (rawSlot.length === 0 || !Number.isInteger(slot) || slot <= 0) {
      invalidSlotBindingIds.push(binding.id);
      continue;
    }

    const workspace =
      binding.workspaceMode === "absolute"
        ? (() => {
            const rawWorkspaceId = binding.workspaceId.trim();
            const workspaceId = Number(rawWorkspaceId);
            if (rawWorkspaceId.length === 0 || !Number.isInteger(workspaceId) || workspaceId <= 0) {
              invalidWorkspaceBindingIds.push(binding.id);
              return null;
            }
            return {
              mode: "absolute",
              workspaceId,
            } as const satisfies ProjectHyprnavWorkspaceTarget;
          })()
        : ({ mode: "managed" } as const satisfies ProjectHyprnavWorkspaceTarget);
    if (workspace === null) {
      continue;
    }

    const name = binding.name.trim();

    if (binding.action === "shell-command") {
      bindings.push({
        id: binding.id,
        slot,
        scope: binding.scope,
        workspace,
        ...(name.length > 0 ? { name } : {}),
        action: "shell-command",
        command: binding.command.trim(),
      });
      continue;
    }

    bindings.push({
      id: binding.id,
      slot,
      scope: binding.scope,
      workspace,
      ...(name.length > 0 ? { name } : {}),
      action: binding.action,
    });
  }

  return {
    settings: { bindings },
    invalidSlotBindingIds,
    invalidWorkspaceBindingIds,
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
      parsed.invalidWorkspaceBindingIds.length > 0 ||
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

function HyprnavWorkspaceAutocomplete({
  mode,
  disabled,
  onChange,
}: {
  mode: ProjectHyprnavWorkspaceTarget["mode"];
  disabled: boolean;
  onChange: (mode: ProjectHyprnavWorkspaceTarget["mode"]) => void;
}) {
  const selectedLabel = findHyprnavWorkspaceLabel(mode);
  const [query, setQuery] = useState(selectedLabel);

  useEffect(() => {
    setQuery(selectedLabel);
  }, [selectedLabel]);

  return (
    <Autocomplete
      items={HYPRNAV_WORKSPACE_ROWS}
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
          {HYPRNAV_WORKSPACE_ROWS.map(({ key, label }, index) => (
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
  headerAction,
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
  headerAction?: ReactNode;
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
        <div className="flex items-center gap-2">
          {headerAction}
          <Button size="xs" variant="outline" disabled={busy} onClick={onAddBinding}>
            <PlusIcon className="size-3.5" />
            Add slot
          </Button>
        </div>
      </div>

      {draft.map((binding) => {
        const parsedSlot = Number(binding.slot);
        const slotInvalid = evaluation.parsed.invalidSlotBindingIds.includes(binding.id);
        const duplicate =
          Number.isInteger(parsedSlot) &&
          evaluation.duplicateScopedSlotKeySet.has(hyprnavScopeSlotKey(binding.scope, parsedSlot));
        const workspaceInvalid = evaluation.parsed.invalidWorkspaceBindingIds.includes(binding.id);
        const shellCommandEmpty = evaluation.validation.emptyShellCommandBindingIds.includes(
          binding.id,
        );
        const rowInvalid = slotInvalid || duplicate || workspaceInvalid || shellCommandEmpty;

        return (
          <div
            key={binding.id}
            className={cn(
              "border-b border-border/60 px-4 py-3 last:border-b-0 lg:px-5",
              rowInvalid && "bg-destructive/4",
            )}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[5.5rem_minmax(0,1fr)] lg:grid-cols-[5.5rem_minmax(11rem,1fr)_minmax(11rem,1fr)_minmax(11rem,1fr)_auto] lg:items-start">
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

              <div className="space-y-1 min-w-0 sm:col-span-2 lg:col-span-1">
                <p className="text-[11px] font-medium text-muted-foreground">Workspace</p>
                <HyprnavWorkspaceAutocomplete
                  mode={binding.workspaceMode}
                  disabled={busy}
                  onChange={(workspaceMode) =>
                    onUpdateBinding(binding.id, (current) => ({
                      ...current,
                      workspaceMode,
                      workspaceId: workspaceMode === "absolute" ? current.workspaceId : "",
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

            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(11rem,13rem)_minmax(11rem,14rem)_minmax(0,1fr)]">
              <div className="space-y-1 min-w-0">
                <p className="text-[11px] font-medium text-muted-foreground">Workspace ID</p>
                {binding.workspaceMode === "absolute" ? (
                  <>
                    <Input
                      aria-invalid={workspaceInvalid}
                      disabled={busy}
                      inputMode="numeric"
                      placeholder="Workspace ID"
                      size="sm"
                      value={binding.workspaceId}
                      onChange={(event) =>
                        onUpdateBinding(binding.id, (current) => ({
                          ...current,
                          workspaceId: event.target.value,
                        }))
                      }
                    />
                    {workspaceInvalid ? (
                      <p className="text-[11px] text-destructive">Use a positive whole number.</p>
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        Hyprland workspace ID for this slot.
                      </p>
                    )}
                  </>
                ) : (
                  <div className="flex min-h-9 items-center rounded-md border border-border/60 bg-muted/20 px-3 text-sm leading-6 text-muted-foreground">
                    Hyprnav-managed workspace
                  </div>
                )}
              </div>

              <div className="space-y-1 min-w-0">
                <p className="text-[11px] font-medium text-muted-foreground">Name</p>
                <Input
                  className="w-full"
                  disabled={busy}
                  placeholder="Fallback workspace name"
                  size="sm"
                  value={binding.name}
                  onChange={(event) =>
                    onUpdateBinding(binding.id, (current) => ({
                      ...current,
                      name: event.target.value,
                    }))
                  }
                />
                <p className="text-[11px] text-muted-foreground">
                  Used when live window or app metadata is unavailable.
                </p>
              </div>

              <div className="space-y-1 min-w-0">
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
                    title={describeManagedBinding(
                      binding.action,
                      binding.scope,
                      binding.workspaceMode,
                      binding.workspaceId,
                    )}
                  >
                    {describeManagedBinding(
                      binding.action,
                      binding.scope,
                      binding.workspaceMode,
                      binding.workspaceId,
                    )}
                  </div>
                )}
                {shellCommandEmpty ? (
                  <p className="text-[11px] text-destructive">Command is required.</p>
                ) : null}
              </div>
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
  const defaultProjectHyprnavSettings = settings.defaultProjectHyprnavSettings;

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

  const effectiveHyprnavByPhysicalKey = useMemo(
    () =>
      new Map(
        groupedProjects.map((candidate) => [
          derivePhysicalProjectKey(candidate),
          resolveProjectHyprnavSettings(candidate.hyprnav, defaultProjectHyprnavSettings),
        ]),
      ),
    [defaultProjectHyprnavSettings, groupedProjects],
  );

  const initialPanelState = useMemo(() => {
    if (!representativeProject) {
      return null;
    }

    const groupedState = logicalProjectKey
      ? settings.groupedProjectHyprnavStateByLogicalProjectKey[logicalProjectKey]
      : undefined;
    const representativePhysicalKey = derivePhysicalProjectKey(representativeProject);
    const representativeHyprnav =
      effectiveHyprnavByPhysicalKey.get(representativePhysicalKey) ?? defaultProjectHyprnavSettings;
    const sharedDraft = draftFromSettings(representativeHyprnav);
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
                draftFromSettings(
                  effectiveHyprnavByPhysicalKey.get(derivePhysicalProjectKey(candidate)) ??
                    defaultProjectHyprnavSettings,
                ),
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
    effectiveHyprnavByPhysicalKey,
    logicalProjectKey,
    representativeProject,
    defaultProjectHyprnavSettings,
    settings.groupedProjectHyprnavStateByLogicalProjectKey,
  ]);

  const [editorMode, setEditorMode] = useState<GroupedProjectHyprnavMode>("same");
  const [sharedDraft, setSharedDraft] = useState<HyprnavDraft | null>(null);
  const [projectDraftsByPhysicalKey, setProjectDraftsByPhysicalKey] = useState<
    Record<string, HyprnavDraft>
  >({});
  const [defaultPhysicalProjectKey, setDefaultPhysicalProjectKey] = useState<string | null>(null);
  const [resetProjectKeys, setResetProjectKeys] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    if (!initialPanelState) {
      setEditorMode("same");
      setSharedDraft(null);
      setProjectDraftsByPhysicalKey({});
      setDefaultPhysicalProjectKey(null);
      setResetProjectKeys([]);
      return;
    }
    setEditorMode(initialPanelState.mode);
    setSharedDraft(cloneDraft(initialPanelState.sharedDraft));
    setProjectDraftsByPhysicalKey(cloneDraftRecord(initialPanelState.projectDraftsByPhysicalKey));
    setDefaultPhysicalProjectKey(initialPanelState.defaultPhysicalProjectKey);
    setResetProjectKeys([]);
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
          projectDraftsByPhysicalKey[physicalProjectKey] ??
          draftFromSettings(
            effectiveHyprnavByPhysicalKey.get(physicalProjectKey) ?? defaultProjectHyprnavSettings,
          );
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
    [
      defaultProjectHyprnavSettings,
      effectiveHyprnavByPhysicalKey,
      groupedProjects,
      projectDraftsByPhysicalKey,
      projectEvaluationsByPhysicalKey,
    ],
  );

  const hasValidationError =
    editorMode === "same"
      ? sharedEvaluation === null || sharedEvaluation.hasValidationError
      : groupEditors.some((editor) => editor.evaluation.hasValidationError);

  const busy = isSaving || isApplying;

  const updateSharedDraft = useCallback(
    (bindingId: string, update: (binding: HyprnavDraftBinding) => HyprnavDraftBinding) => {
      setResetProjectKeys([]);
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
      setResetProjectKeys((current) => current.filter((key) => key !== physicalProjectKey));
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
    setResetProjectKeys([]);
    setSharedDraft((current) => {
      const nextDraft = current ?? [];
      return [
        ...nextDraft,
        {
          id: makeCustomBindingId(),
          slot: String(findNextSlot(nextDraft)),
          scope: "worktree",
          workspaceMode: "managed",
          workspaceId: "",
          name: "",
          action: "shell-command",
          command: "",
        },
      ];
    });
  }, []);

  const addProjectBinding = useCallback((physicalProjectKey: string) => {
    setResetProjectKeys((current) => current.filter((key) => key !== physicalProjectKey));
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
            workspaceMode: "managed",
            workspaceId: "",
            name: "",
            action: "shell-command",
            command: "",
          },
        ],
      };
    });
  }, []);

  const removeSharedBinding = useCallback((bindingId: string) => {
    setResetProjectKeys([]);
    setSharedDraft((current) =>
      current ? current.filter((binding) => binding.id !== bindingId) : current,
    );
  }, []);

  const removeProjectBinding = useCallback((physicalProjectKey: string, bindingId: string) => {
    setResetProjectKeys((current) => current.filter((key) => key !== physicalProjectKey));
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
      setResetProjectKeys([]);
      setSharedDraft((current) =>
        current
          ? restoreDraftBinding(
              current,
              bindingId,
              effectiveHyprnavByPhysicalKey.get(derivePhysicalProjectKey(representativeProject)) ??
                defaultProjectHyprnavSettings,
            )
          : current,
      );
    },
    [defaultProjectHyprnavSettings, effectiveHyprnavByPhysicalKey, representativeProject],
  );

  const restoreProjectBinding = useCallback(
    (physicalProjectKey: string, bindingId: string) => {
      const hasSourceProject = groupedProjects.some(
        (candidate) => derivePhysicalProjectKey(candidate) === physicalProjectKey,
      );
      if (!hasSourceProject) {
        return;
      }
      setResetProjectKeys((current) => current.filter((key) => key !== physicalProjectKey));
      setProjectDraftsByPhysicalKey((current) => {
        const draft = current[physicalProjectKey];
        if (!draft) {
          return current;
        }
        return {
          ...current,
          [physicalProjectKey]: restoreDraftBinding(
            draft,
            bindingId,
            effectiveHyprnavByPhysicalKey.get(physicalProjectKey) ?? defaultProjectHyprnavSettings,
          ),
        };
      });
    },
    [defaultProjectHyprnavSettings, effectiveHyprnavByPhysicalKey, groupedProjects],
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
    setResetProjectKeys([]);
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
      setResetProjectKeys([]);
    },
    [groupedProjects, projectDraftsByPhysicalKey],
  );

  const resetSharedToDefault = useCallback(() => {
    setSharedDraft(draftFromSettings(defaultProjectHyprnavSettings));
    setResetProjectKeys(groupedProjects.map((candidate) => derivePhysicalProjectKey(candidate)));
  }, [defaultProjectHyprnavSettings, groupedProjects]);

  const resetProjectToDefault = useCallback(
    (physicalProjectKey: string) => {
      setProjectDraftsByPhysicalKey((current) => ({
        ...current,
        [physicalProjectKey]: draftFromSettings(defaultProjectHyprnavSettings),
      }));
      setResetProjectKeys((current) =>
        current.includes(physicalProjectKey) ? current : [...current, physicalProjectKey],
      );
    },
    [defaultProjectHyprnavSettings],
  );

  const save = useCallback(async () => {
    if (!project || !logicalProjectKey || groupedProjects.length === 0 || hasValidationError) {
      return;
    }

    const nextSettingsByPhysicalKey = new Map<string, ProjectHyprnavSettings>();
    const nextOverridesByPhysicalKey = new Map<string, ProjectHyprnavOverride>();
    if (editorMode === "same") {
      if (!sharedEvaluation) {
        return;
      }
      for (const candidate of groupedProjects) {
        const physicalProjectKey = derivePhysicalProjectKey(candidate);
        const nextOverride =
          resetProjectKeys.includes(physicalProjectKey) ||
          (projectUsesDefaultHyprnav(candidate.hyprnav) &&
            hyprnavSettingsEqual(sharedEvaluation.parsed.settings, defaultProjectHyprnavSettings))
            ? null
            : sharedEvaluation.parsed.settings;
        nextOverridesByPhysicalKey.set(physicalProjectKey, nextOverride);
        nextSettingsByPhysicalKey.set(
          physicalProjectKey,
          resolveProjectHyprnavSettings(nextOverride, defaultProjectHyprnavSettings),
        );
      }
    } else {
      for (const editor of groupEditors) {
        const nextOverride =
          resetProjectKeys.includes(editor.physicalProjectKey) ||
          (projectUsesDefaultHyprnav(editor.project.hyprnav) &&
            hyprnavSettingsEqual(editor.evaluation.parsed.settings, defaultProjectHyprnavSettings))
            ? null
            : editor.evaluation.parsed.settings;
        nextOverridesByPhysicalKey.set(editor.physicalProjectKey, nextOverride);
        nextSettingsByPhysicalKey.set(
          editor.physicalProjectKey,
          resolveProjectHyprnavSettings(nextOverride, defaultProjectHyprnavSettings),
        );
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
          hyprnav: nextOverridesByPhysicalKey.get(derivePhysicalProjectKey(candidate))!,
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
              resolveProjectHyprnavSettings(candidate.hyprnav, defaultProjectHyprnavSettings),
              nextSettingsByPhysicalKey.get(derivePhysicalProjectKey(candidate))!,
            ),
          ]),
        );
        const clearNamesByProjectKey = new Map(
          localBaseProjects.map((candidate) => [
            scopedProjectKey(scopeProjectRef(candidate.environmentId, candidate.id)),
            computeClearedHyprnavBindingNames(
              resolveProjectHyprnavSettings(candidate.hyprnav, defaultProjectHyprnavSettings),
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
          clearNamesByProjectKey,
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
            threadTitle: job.threadTitle,
            hyprnav: job.hyprnav,
            preferredEditor,
            clearBindings: job.clearBindings,
            clearNames: job.clearNames,
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
    defaultProjectHyprnavSettings,
    editorMode,
    groupEditors,
    groupedProjects,
    hasValidationError,
    localEnvironmentId,
    resetProjectKeys,
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
          const usesDefault = projectUsesDefaultHyprnav(candidate.hyprnav);

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
                    <div className="flex items-center gap-2">
                      <Badge size="sm" variant="outline">
                        {usesDefault ? "Inherited" : "Custom"}
                      </Badge>
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => makeDefaultProject(physicalProjectKey)}
                      >
                        Make default
                      </Button>
                    </div>
                  )
                ) : (
                  <Badge size="sm" variant="outline">
                    {usesDefault ? "Inherited" : "Custom"}
                  </Badge>
                )
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection
        title="Hyprnav"
        headerAction={
          <div className="flex items-center gap-2">
            {editorMode === "same" ? (
              <Button size="xs" variant="outline" disabled={busy} onClick={resetSharedToDefault}>
                Reset to default
              </Button>
            ) : null}
            <Button size="xs" disabled={hasValidationError || busy} onClick={() => void save()}>
              {isApplying ? "Applying..." : isSaving ? "Saving..." : "Save and apply"}
            </Button>
          </div>
        }
      >
        {editorMode === "same" ? (
          <HyprnavBindingsEditor
            title="Shared settings"
            description={
              groupedProjects.length > 1
                ? "Changes here apply to every project in this list. Reset returns all of them to the global default."
                : "Changes here apply to this project. Reset returns it to the global default."
            }
            draft={sharedDraft}
            evaluation={sharedEvaluation ?? evaluateDraft(sharedDraft)}
            busy={busy}
            headerAction={
              groupedProjects.length > 1 ? (
                <Badge size="sm" variant="outline">
                  Shared
                </Badge>
              ) : (
                <Badge size="sm" variant="outline">
                  {projectUsesDefaultHyprnav(project.hyprnav) ? "Inherited" : "Custom"}
                </Badge>
              )
            }
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
              headerAction={
                <div className="flex items-center gap-2">
                  <Badge size="sm" variant="outline">
                    {projectUsesDefaultHyprnav(editor.project.hyprnav) ? "Inherited" : "Custom"}
                  </Badge>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => resetProjectToDefault(editor.physicalProjectKey)}
                  >
                    Reset to default
                  </Button>
                </div>
              }
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

export function HyprnavDefaultsSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [draft, setDraft] = useState<HyprnavDraft>(() =>
    draftFromSettings(settings.defaultProjectHyprnavSettings),
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setDraft(draftFromSettings(settings.defaultProjectHyprnavSettings));
  }, [settings.defaultProjectHyprnavSettings]);

  const evaluation = useMemo(() => evaluateDraft(draft), [draft]);
  const busy = isSaving;

  const saveDefaults = useCallback(async () => {
    if (evaluation.hasValidationError) {
      return;
    }

    setIsSaving(true);
    try {
      updateSettings({
        defaultProjectHyprnavSettings: evaluation.parsed.settings,
      });
      toastManager.add({
        type: "success",
        title: "Hyprnav defaults saved",
      });
    } finally {
      setIsSaving(false);
    }
  }, [evaluation, updateSettings]);

  return (
    <SettingsPageContainer width="wide">
      <SettingsSection
        title="Hyprnav defaults"
        headerAction={
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => setDraft(draftFromSettings(DEFAULT_PROJECT_HYPRNAV_SETTINGS))}
            >
              Restore built-in defaults
            </Button>
            <Button
              size="xs"
              disabled={evaluation.hasValidationError || busy}
              onClick={() => void saveDefaults()}
            >
              {isSaving ? "Saving..." : "Save defaults"}
            </Button>
          </div>
        }
      >
        <HyprnavBindingsEditor
          title="Global defaults"
          description="These settings apply to every project that has not been customized."
          draft={draft}
          evaluation={evaluation}
          busy={busy}
          onUpdateBinding={(bindingId, update) =>
            setDraft((current) =>
              current.map((binding) => (binding.id === bindingId ? update(binding) : binding)),
            )
          }
          onRestoreBinding={(bindingId) =>
            setDraft((current) =>
              restoreDraftBinding(current, bindingId, settings.defaultProjectHyprnavSettings),
            )
          }
          onAddBinding={() =>
            setDraft((current) => [
              ...current,
              {
                id: makeCustomBindingId(),
                slot: String(findNextSlot(current)),
                scope: "worktree",
                workspaceMode: "managed",
                workspaceId: "",
                name: "",
                action: "shell-command",
                command: "",
              },
            ])
          }
          onRemoveBinding={(bindingId) =>
            setDraft((current) => current.filter((binding) => binding.id !== bindingId))
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
