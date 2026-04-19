import { useCallback, useEffect, useMemo, useState } from "react";
import { scopeProjectRef } from "@t3tools/client-runtime";
import {
  DEFAULT_PROJECT_HYPRNAV_SETTINGS,
  type EnvironmentId,
  type ProjectHyprnavAction,
  type ProjectHyprnavBinding,
  type ProjectHyprnavSettings,
  type ProjectId,
} from "@t3tools/contracts";
import {
  CommandIcon,
  PlusIcon,
  StarIcon,
  TerminalSquareIcon,
  Trash2Icon,
  type LucideIcon,
} from "lucide-react";

import {
  computeRemovedHyprnavSlots,
  findHyprnavActionLabel,
  HYPRNAV_ACTION_ROWS,
  validateProjectHyprnavSettings,
} from "../../hyprnavSettings";
import { readEnvironmentApi } from "../../environmentApi";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { cn, newCommandId } from "../../lib/utils";
import { useServerAvailableEditors } from "../../rpc/serverState";
import { selectProjectByRef, useStore } from "../../store";
import {
  Autocomplete,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
  action: ProjectHyprnavAction;
  command: string;
};
type HyprnavDraft = HyprnavDraftBinding[];

const ACTION_ICONS = {
  "worktree-terminal": TerminalSquareIcon,
  "open-favorite-editor": StarIcon,
  "shell-command": CommandIcon,
} satisfies Record<ProjectHyprnavAction, LucideIcon>;

function makeCustomBindingId(): string {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function draftBindingFromSettings(binding: ProjectHyprnavBinding): HyprnavDraftBinding {
  return {
    id: binding.id,
    slot: String(binding.slot),
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

function describeManagedBinding(action: ProjectHyprnavAction, projectCwd: string): string {
  switch (action) {
    case "worktree-terminal":
      return `ghostty --working-directory=${projectCwd} -e tmux`;
    case "open-favorite-editor":
      return findHyprnavActionLabel(action);
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
        action: "shell-command",
        command: binding.command.trim(),
      });
      continue;
    }

    bindings.push({
      id: binding.id,
      slot,
      action: binding.action,
    });
  }

  return {
    settings: { bindings },
    invalidSlotBindingIds,
  };
}

function replaceDraftBinding(
  draft: HyprnavDraft,
  bindingId: string,
  nextBinding: HyprnavDraftBinding,
): HyprnavDraft {
  return draft.map((binding) => (binding.id === bindingId ? nextBinding : binding));
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

export function ProjectHyprnavSettingsPanel({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const projectRef = useMemo(
    () => scopeProjectRef(environmentId, projectId),
    [environmentId, projectId],
  );
  const project = useStore((store) => selectProjectByRef(store, projectRef));
  const availableEditors = useServerAvailableEditors();
  const [draft, setDraft] = useState<HyprnavDraft | null>(() =>
    project ? draftFromSettings(project.hyprnav) : null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isApplying, setIsApplying] = useState(false);

  useEffect(() => {
    setDraft(project ? draftFromSettings(project.hyprnav) : null);
  }, [project]);

  const parsed = useMemo(() => (draft ? parseDraft(draft) : null), [draft]);
  const validation = parsed
    ? validateProjectHyprnavSettings(parsed.settings)
    : { duplicateSlots: [], emptyShellCommandBindingIds: [] };
  const hasValidationError =
    parsed === null ||
    parsed.invalidSlotBindingIds.length > 0 ||
    validation.duplicateSlots.length > 0 ||
    validation.emptyShellCommandBindingIds.length > 0;
  const busy = isSaving || isApplying;

  const updateDraft = useCallback(
    (bindingId: string, update: (binding: HyprnavDraftBinding) => HyprnavDraftBinding) => {
      setDraft((current) =>
        current
          ? current.map((binding) => (binding.id === bindingId ? update(binding) : binding))
          : current,
      );
    },
    [],
  );

  const restoreBinding = useCallback(
    (bindingId: string) => {
      if (!project) {
        return;
      }
      setDraft((current) => {
        if (!current) {
          return current;
        }

        const defaultBinding = defaultDraftBinding(bindingId);
        if (defaultBinding) {
          return replaceDraftBinding(current, bindingId, defaultBinding);
        }

        const savedBinding = project.hyprnav.bindings.find((binding) => binding.id === bindingId);
        if (savedBinding) {
          return replaceDraftBinding(current, bindingId, draftBindingFromSettings(savedBinding));
        }

        return replaceDraftBinding(current, bindingId, {
          id: bindingId,
          slot: current.find((binding) => binding.id === bindingId)?.slot ?? "",
          action: "shell-command",
          command: "",
        });
      });
    },
    [project],
  );

  const addBinding = useCallback(() => {
    setDraft((current) => {
      const nextDraft = current ?? [];
      return [
        ...nextDraft,
        {
          id: makeCustomBindingId(),
          slot: String(findNextSlot(nextDraft)),
          action: "shell-command",
          command: "",
        },
      ];
    });
  }, []);

  const removeBinding = useCallback((bindingId: string) => {
    setDraft((current) =>
      current ? current.filter((binding) => binding.id !== bindingId) : current,
    );
  }, []);

  const save = useCallback(async () => {
    if (!project || !parsed || hasValidationError) {
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Project settings unavailable",
        description: "The selected environment is not connected.",
      });
      return;
    }

    setIsSaving(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: project.id,
        hyprnav: parsed.settings,
      });

      const syncHyprnavEnvironment = window.desktopBridge?.syncHyprnavEnvironment;
      if (syncHyprnavEnvironment) {
        setIsApplying(true);
        const needsPreferredEditor = parsed.settings.bindings.some(
          (binding) => binding.action === "open-favorite-editor",
        );
        const preferredEditor = needsPreferredEditor
          ? resolveAndPersistPreferredEditor(availableEditors)
          : null;
        const result = await syncHyprnavEnvironment({
          environmentPath: project.cwd,
          projectRoot: project.cwd,
          hyprnav: parsed.settings,
          preferredEditor,
          clearSlots: computeRemovedHyprnavSlots(project.hyprnav, parsed.settings),
          lock: true,
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

      toastManager.add({
        type: "success",
        title: syncHyprnavEnvironment
          ? "Project settings saved and applied"
          : "Project settings saved",
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
  }, [availableEditors, environmentId, hasValidationError, parsed, project]);

  if (!project || !draft || !parsed) {
    return (
      <SettingsPageContainer>
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
    <SettingsPageContainer>
      <SettingsSection title="Project">
        <SettingsRow title="Name" description={project.name} />
        <SettingsRow
          title="Workspace root"
          description={project.cwd}
          status={<span className="break-all font-mono">{project.cwd}</span>}
        />
      </SettingsSection>

      <SettingsSection
        title="Hyprnav"
        headerAction={
          <div className="flex items-center gap-2">
            <Button size="xs" variant="outline" disabled={busy} onClick={addBinding}>
              <PlusIcon className="size-3.5" />
              Add slot
            </Button>
            <Button size="xs" disabled={hasValidationError || busy} onClick={() => void save()}>
              {isApplying ? "Applying..." : isSaving ? "Saving..." : "Save and apply"}
            </Button>
          </div>
        }
      >
        <div className="hidden grid-cols-[5.5rem_minmax(12rem,1fr)_minmax(12rem,1fr)_4.5rem] items-center gap-2 border-b border-border/60 px-4 py-2 text-[11px] font-medium text-muted-foreground sm:grid sm:px-5">
          <span>Slot</span>
          <span>Action</span>
          <span>Command</span>
          <span className="sr-only">Actions</span>
        </div>
        {draft.map((binding) => {
          const parsedSlot = Number(binding.slot);
          const slotInvalid = parsed.invalidSlotBindingIds.includes(binding.id);
          const duplicate =
            Number.isInteger(parsedSlot) && validation.duplicateSlots.includes(parsedSlot);
          const shellCommandEmpty = validation.emptyShellCommandBindingIds.includes(binding.id);
          const rowInvalid = slotInvalid || duplicate || shellCommandEmpty;
          return (
            <div
              key={binding.id}
              className={cn(
                "grid grid-cols-1 items-start gap-2 border-b border-border/60 px-4 py-3 last:border-b-0 sm:grid-cols-[5.5rem_minmax(12rem,1fr)_minmax(12rem,1fr)_4.5rem] sm:px-5",
                rowInvalid && "bg-destructive/4",
              )}
            >
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground sm:hidden">Slot</p>
                <Input
                  aria-invalid={slotInvalid || duplicate}
                  disabled={busy}
                  inputMode="numeric"
                  size="sm"
                  value={binding.slot}
                  onChange={(event) =>
                    updateDraft(binding.id, (current) => ({
                      ...current,
                      slot: event.target.value,
                    }))
                  }
                />
                {slotInvalid ? (
                  <p className="text-[11px] text-destructive">Use a positive whole number.</p>
                ) : duplicate ? (
                  <p className="text-[11px] text-destructive">Already used.</p>
                ) : null}
              </div>
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground sm:hidden">Action</p>
                <HyprnavActionAutocomplete
                  action={binding.action}
                  disabled={busy}
                  onChange={(action) =>
                    updateDraft(binding.id, (current) => ({
                      ...current,
                      action,
                      command: action === "shell-command" ? current.command : "",
                    }))
                  }
                />
              </div>
              <div className="space-y-1">
                <p className="text-[11px] font-medium text-muted-foreground sm:hidden">Command</p>
                {binding.action === "shell-command" ? (
                  <Input
                    aria-invalid={shellCommandEmpty}
                    disabled={busy}
                    placeholder="sh command"
                    size="sm"
                    value={binding.command}
                    onChange={(event) =>
                      updateDraft(binding.id, (current) => ({
                        ...current,
                        command: event.target.value,
                      }))
                    }
                  />
                ) : (
                  <div
                    className={cn(
                      "flex min-h-7 items-center rounded-md border border-transparent px-2 text-sm text-muted-foreground",
                      binding.action === "worktree-terminal" && "break-all font-mono text-xs",
                    )}
                    title={describeManagedBinding(binding.action, project.cwd)}
                  >
                    {describeManagedBinding(binding.action, project.cwd)}
                  </div>
                )}
                {shellCommandEmpty ? (
                  <p className="text-[11px] text-destructive">Command is required.</p>
                ) : null}
              </div>
              <div className="flex h-7 items-center justify-end gap-1">
                <SettingResetButton
                  label={`${findHyprnavActionLabel(binding.action)} slot`}
                  onClick={() => restoreBinding(binding.id)}
                />
                <Button
                  aria-label={`Remove ${findHyprnavActionLabel(binding.action)} slot`}
                  className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                  disabled={busy}
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => removeBinding(binding.id)}
                >
                  <Trash2Icon className="size-3" />
                </Button>
              </div>
            </div>
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
