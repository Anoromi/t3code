import type { KeybindingCommand } from "@t3tools/contracts";
import type { ReactNode } from "react";

export type ThreadCommandBarGroupId = "actions" | "open-in" | "git";

export interface ThreadCommandBarItem {
  id: string;
  group: ThreadCommandBarGroupId;
  title: string;
  description?: string;
  searchTerms: readonly string[];
  icon: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  shortcutCommand?: KeybindingCommand;
  run: () => Promise<void> | void;
}

export interface ThreadCommandBarGroup {
  id: ThreadCommandBarGroupId;
  label: string;
  items: ThreadCommandBarItem[];
}

const GROUP_LABELS = {
  actions: "Actions",
  "open-in": "Open In",
  git: "Git",
} satisfies Record<ThreadCommandBarGroupId, string>;

export const THREAD_COMMAND_BAR_GROUP_ORDER: readonly ThreadCommandBarGroupId[] = [
  "actions",
  "open-in",
  "git",
];

export function normalizeCommandBarSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function rankSearchField(field: string, query: string): number {
  const normalizedField = normalizeCommandBarSearchText(field);
  if (normalizedField.length === 0 || !normalizedField.includes(query)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === query) return 4;
  if (normalizedField.startsWith(query)) return 3;
  return 1;
}

export function rankThreadCommandBarItem(item: ThreadCommandBarItem, query: string): number {
  const fields = [item.title, item.description ?? "", ...item.searchTerms];

  for (const [index, field] of fields.entries()) {
    const fieldRank = rankSearchField(field, query);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return 1_000 - index * 100 + fieldRank;
    }
  }

  return Number.NEGATIVE_INFINITY;
}

export function buildThreadCommandBarGroups(
  items: ReadonlyArray<ThreadCommandBarItem>,
): ThreadCommandBarGroup[] {
  return THREAD_COMMAND_BAR_GROUP_ORDER.flatMap((groupId) => {
    const groupItems = items.filter((item) => item.group === groupId);
    if (groupItems.length === 0) return [];
    return [{ id: groupId, label: GROUP_LABELS[groupId], items: groupItems }];
  });
}

export function filterThreadCommandBarGroups(input: {
  items: ReadonlyArray<ThreadCommandBarItem>;
  query: string;
}): ThreadCommandBarGroup[] {
  const normalizedQuery = normalizeCommandBarSearchText(input.query);
  if (normalizedQuery.length === 0) {
    return buildThreadCommandBarGroups(input.items);
  }

  const rankedItems = input.items
    .map((item, index) => ({
      item,
      index,
      rank: rankThreadCommandBarItem(item, normalizedQuery),
    }))
    .filter((entry) => entry.rank !== Number.NEGATIVE_INFINITY)
    .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
    .map((entry) => entry.item);

  return buildThreadCommandBarGroups(rankedItems);
}

export function dedupeThreadCommandBarItems(
  items: ReadonlyArray<ThreadCommandBarItem>,
): ThreadCommandBarItem[] {
  const seen = new Set<string>();
  const deduped: ThreadCommandBarItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}
