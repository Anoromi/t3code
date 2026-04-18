import { type CodexReasoningEffort } from "@t3tools/contracts";
import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

export type ComposerTriggerKind = "path" | "slash-command" | "slash-model" | "skill";
export type ComposerSlashCommand =
  | "model"
  | "plan"
  | "default"
  | "fast"
  | "reasoning"
  | "fork"
  | "branch"
  | "worktree";
export type ComposerStandaloneSlashCommand =
  | Exclude<ComposerSlashCommand, "model" | "reasoning" | "branch" | "worktree">
  | { kind: "reasoning"; effort: CodexReasoningEffort };
export type ComposerMenuSlashCommand = Extract<
  ComposerSlashCommand,
  "reasoning" | "branch" | "worktree"
>;

export interface ParsedComposerMenuSlashCommandQuery {
  command: ComposerMenuSlashCommand;
  valueQuery: string;
}

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

export function composerTriggersEqual(
  left: ComposerTrigger | null,
  right: ComposerTrigger | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.kind === right.kind &&
    left.query === right.query &&
    left.rangeStart === right.rangeStart &&
    left.rangeEnd === right.rangeEnd
  );
}

const SLASH_COMMANDS: readonly ComposerSlashCommand[] = [
  "model",
  "plan",
  "default",
  "fast",
  "reasoning",
  "fork",
  "branch",
  "worktree",
];
const REASONING_COMMAND_ALIASES = ["reasoning", "r"] as const;

export function normalizeReasoningCommandAlias(command: string): "reasoning" | null {
  const normalized = command.trim().toLowerCase();
  return REASONING_COMMAND_ALIASES.includes(
    normalized as (typeof REASONING_COMMAND_ALIASES)[number],
  )
    ? "reasoning"
    : null;
}

export function normalizeReasoningValue(value: string): CodexReasoningEffort | null {
  switch (value.trim().toLowerCase()) {
    case "xh":
    case "xhigh":
      return "xhigh";
    case "h":
    case "high":
      return "high";
    case "m":
    case "medium":
      return "medium";
    case "l":
    case "low":
      return "low";
    default:
      return null;
  }
}
export function parseComposerMenuSlashCommandQuery(
  query: string,
): ParsedComposerMenuSlashCommandQuery | null {
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    return null;
  }

  const match = /^(reasoning|r|branch|worktree)(?:\s+(.*))?$/i.exec(trimmedQuery);
  if (!match) {
    return null;
  }

  const rawCommand = match[1]?.toLowerCase() ?? "";
  const command =
    normalizeReasoningCommandAlias(rawCommand) ??
    (rawCommand === "branch" || rawCommand === "worktree" ? rawCommand : null);
  if (!command) {
    return null;
  }

  return {
    command,
    valueQuery: (match[2] ?? "").trim(),
  };
}

const isInlineTokenSegment = (
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): boolean => segment.type !== "text";

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return (
    char === " " ||
    char === "\n" ||
    char === "\t" ||
    char === "\r" ||
    char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER
  );
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

export function expandCollapsedComposerCursor(text: string, cursorInput: number): number {
  const collapsedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return collapsedCursor;
  }

  let remaining = collapsedCursor;
  let expandedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.path.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining <= 1) {
        return expandedCursor + (remaining === 0 ? 0 : expandedLength);
      }
      remaining -= 1;
      expandedCursor += expandedLength;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return expandedCursor + remaining;
      }
      remaining -= 1;
      expandedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return expandedCursor + remaining;
    }
    remaining -= segmentLength;
    expandedCursor += segmentLength;
  }

  return expandedCursor;
}

function collapsedSegmentLength(
  segment:
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" },
): number {
  if (segment.type === "text") {
    return segment.text.length;
  }
  return 1;
}

function clampCollapsedComposerCursorForSegments(
  segments: ReadonlyArray<
    | { type: "text"; text: string }
    | { type: "mention" }
    | { type: "skill" }
    | { type: "terminal-context" }
  >,
  cursorInput: number,
): number {
  const collapsedLength = segments.reduce(
    (total, segment) => total + collapsedSegmentLength(segment),
    0,
  );
  if (!Number.isFinite(cursorInput)) {
    return collapsedLength;
  }
  return Math.max(0, Math.min(collapsedLength, Math.floor(cursorInput)));
}

export function clampCollapsedComposerCursor(text: string, cursorInput: number): number {
  return clampCollapsedComposerCursorForSegments(
    splitPromptIntoComposerSegments(text),
    cursorInput,
  );
}

export function collapseExpandedComposerCursor(text: string, cursorInput: number): number {
  const expandedCursor = clampCursor(text, cursorInput);
  const segments = splitPromptIntoComposerSegments(text);
  if (segments.length === 0) {
    return expandedCursor;
  }

  let remaining = expandedCursor;
  let collapsedCursor = 0;

  for (const segment of segments) {
    if (segment.type === "mention") {
      const expandedLength = segment.path.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "skill") {
      const expandedLength = segment.name.length + 1;
      if (remaining === 0) {
        return collapsedCursor;
      }
      if (remaining <= expandedLength) {
        return collapsedCursor + 1;
      }
      remaining -= expandedLength;
      collapsedCursor += 1;
      continue;
    }
    if (segment.type === "terminal-context") {
      if (remaining <= 1) {
        return collapsedCursor + remaining;
      }
      remaining -= 1;
      collapsedCursor += 1;
      continue;
    }

    const segmentLength = segment.text.length;
    if (remaining <= segmentLength) {
      return collapsedCursor + remaining;
    }
    remaining -= segmentLength;
    collapsedCursor += segmentLength;
  }

  return collapsedCursor;
}

export function isCollapsedCursorAdjacentToInlineToken(
  text: string,
  cursorInput: number,
  direction: "left" | "right",
): boolean {
  const segments = splitPromptIntoComposerSegments(text);
  if (!segments.some(isInlineTokenSegment)) {
    return false;
  }

  const cursor = clampCollapsedComposerCursorForSegments(segments, cursorInput);
  let collapsedOffset = 0;

  for (const segment of segments) {
    if (isInlineTokenSegment(segment)) {
      if (direction === "left" && cursor === collapsedOffset + 1) {
        return true;
      }
      if (direction === "right" && cursor === collapsedOffset) {
        return true;
      }
    }
    collapsedOffset += collapsedSegmentLength(segment);
  }

  return false;
}

export const isCollapsedCursorAdjacentToMention = isCollapsedCursorAdjacentToInlineToken;

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const menuSlashMatch = /^\/(reasoning|r|branch|worktree)(?:\s+(.*))?$/i.exec(linePrefix);
    if (menuSlashMatch) {
      const rawCommand = menuSlashMatch[1]?.toLowerCase() ?? "reasoning";
      const command = normalizeReasoningCommandAlias(rawCommand) ?? rawCommand;
      const valueQuery = menuSlashMatch[2] ?? "";
      return {
        kind: "slash-command",
        query: `${command}${linePrefix.endsWith(" ") ? ` ${valueQuery}` : valueQuery ? ` ${valueQuery}` : ""}`,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("$")) {
    return {
      kind: "skill",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function parseStandaloneComposerSlashCommand(
  text: string,
): ComposerStandaloneSlashCommand | null {
  const match = /^\/(plan|default|fast|fork)\s*$/i.exec(text.trim());
  if (match) {
    const command = match[1]?.toLowerCase();
    if (command === "plan") return "plan";
    if (command === "fast") return "fast";
    if (command === "fork") return "fork";
    return "default";
  }

  const reasoningMatch = /^\/(?:reasoning|r)\s+(\S+)\s*$/i.exec(text.trim());
  if (!reasoningMatch) {
    return null;
  }
  const effort = normalizeReasoningValue(reasoningMatch[1] ?? "");
  return effort ? { kind: "reasoning", effort } : null;
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}
