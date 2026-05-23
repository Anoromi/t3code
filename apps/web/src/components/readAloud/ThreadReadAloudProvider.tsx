import { HeadphonesIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import type { EnvironmentId, ReadAloudTimingChunk } from "@t3tools/contracts";
import type {
  ReadAloudHighlightStyle,
  ReadAloudIndicatorType,
  ReadAloudVoice,
} from "@t3tools/contracts/settings";

import {
  createAudioPlaybackHandle,
  type AudioPlaybackHandle,
  type AudioPlaybackSnapshot,
} from "../../lib/audioPlayback";
import { cn } from "../../lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildReadAloudHighlightGroups,
  highlightGroupForTime,
  highlightGroupIndexForWordIndex,
  sentenceIndexForWordIndex,
  sentenceSpans,
  wordIndexForTime,
  wordSpans,
  type HighlightGroup,
  type TextSpan,
} from "./readAloudTextSegmentation";
import { computeReadAloudCodeHoldMetrics } from "./readAloudSilentUnits";
import { ReadAloudWpmPopoverControl } from "./ReadAloudWpmPopoverControl";
import {
  DEFAULT_READ_ALOUD_INDICATOR_TYPE,
  DEFAULT_READ_ALOUD_HIGHLIGHT_STYLE,
  DEFAULT_READ_ALOUD_TARGET_WPM,
  DEFAULT_READ_ALOUD_VOICE,
  READ_ALOUD_HIGHLIGHT_SELECT_ITEMS,
  READ_ALOUD_HIGHLIGHT_STYLES,
  MAX_READ_ALOUD_WPM,
  MIN_READ_ALOUD_WPM,
  READ_ALOUD_INDICATOR_LABELS,
  READ_ALOUD_VOICES,
  READ_ALOUD_VOICE_SELECT_ITEMS,
  readAloudVoiceLabel,
} from "./readAloudSettings";
import {
  normalizeSpeechTextWithAlignment,
  type SpeechTokenAlignment,
} from "./speechTextNormalizer";

const READ_MENU_ID = "read-from-here";
const COPY_MENU_ID = "copy";
const COPY_SENTENCE_MENU_ID = "copy-sentence";
const COPY_PARAGRAPH_MENU_ID = "copy-paragraph";
export const READ_ALOUD_CONTEXT_MENU_ITEMS = [
  { id: COPY_MENU_ID, label: "Copy" },
  { id: READ_MENU_ID, label: "Read from here" },
  { id: COPY_SENTENCE_MENU_ID, label: "Copy sentence" },
  { id: COPY_PARAGRAPH_MENU_ID, label: "Copy paragraph" },
] as const;
const READABLE_SELECTOR = "p, li, h1, h2, h3, h4, h5, h6, pre";
const READ_ALOUD_MARKDOWN_ROOT_SELECTOR = ".chat-markdown";
const READ_ALOUD_THREAD_SCOPE_SELECTOR = "[data-read-aloud-thread-scope='true']";
const READ_ALOUD_EXCLUDED_CONTAINER_SELECTOR =
  "[data-read-aloud-skip], [data-read-aloud-skip='true']";
const EXCLUDED_SELECTOR = `textarea, input, button, select, [contenteditable], ${READ_ALOUD_EXCLUDED_CONTAINER_SELECTOR}`;
const HIGHLIGHT_NAME = "t3code-read-aloud-sentence";
const WORD_HIGHLIGHT_NAME = "t3code-read-aloud-word";
const WORD_HIGHLIGHT_OVERLAY_ID = "t3code-read-aloud-word-overlay";
const WORD_HIGHLIGHT_OVERLAY_HOST_ATTRIBUTE = "data-read-aloud-overlay-host";
const DEFAULT_TARGET_WPM = DEFAULT_READ_ALOUD_TARGET_WPM;
const MIN_WPM = MIN_READ_ALOUD_WPM;
const MAX_WPM = MAX_READ_ALOUD_WPM;
const DEFAULT_VOICE = DEFAULT_READ_ALOUD_VOICE;
const VOICES = READ_ALOUD_VOICES;
const HIGHLIGHT_STYLE_ID = "t3code-read-aloud-highlight-style";
const HIGHLIGHT_TICK_MS = 50;
const READ_ALOUD_SCROLL_TOP_GUARD_PX = 96;
const READ_ALOUD_SCROLL_BOTTOM_RATIO = 2 / 3;
const READ_ALOUD_SCROLL_TARGET_RATIO = 0.5;
const DEFAULT_HIGHLIGHT_VARIANT = DEFAULT_READ_ALOUD_HIGHLIGHT_STYLE;

type ReadAloudHighlightVariant = ReadAloudHighlightStyle;
type ReadAloudMode =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "showing-code"
  | "code-paused"
  | "error";

interface ReadAloudHighlightVariantCss {
  readonly sentenceBackground: string;
  readonly sentenceUnderline: string;
  readonly wordBackground: string;
  readonly wordColor: string;
  readonly wordUnderline: string;
  readonly overlayBackground: string;
  readonly overlayBorder: string;
  readonly overlayRadius: string;
  readonly overlayShadow: string;
  readonly codeBackground: string;
  readonly codeBorder: string;
  readonly codeRadius: string;
  readonly codeShadow: string;
}

const READ_ALOUD_HIGHLIGHT_VARIANT_CSS: Record<
  ReadAloudHighlightVariant,
  ReadAloudHighlightVariantCss
> = {
  "soft-wash": {
    sentenceBackground: "color-mix(in srgb, var(--primary) 5%, transparent)",
    sentenceUnderline: "color-mix(in srgb, var(--primary) 28%, transparent)",
    wordBackground: "color-mix(in srgb, var(--foreground) 5%, transparent)",
    wordColor: "var(--foreground)",
    wordUnderline: "color-mix(in srgb, var(--primary) 62%, transparent)",
    overlayBackground: "color-mix(in srgb, var(--foreground) 8%, transparent)",
    overlayBorder: "1px solid color-mix(in srgb, var(--foreground) 9%, transparent)",
    overlayRadius: "4px",
    overlayShadow: "inset 0 -2px 0 color-mix(in srgb, var(--primary) 58%, transparent)",
    codeBackground: "color-mix(in srgb, var(--foreground) 4%, transparent)",
    codeBorder: "1px solid color-mix(in srgb, var(--foreground) 11%, transparent)",
    codeRadius: "0.75rem",
    codeShadow:
      "inset 0 0 0 9999px color-mix(in srgb, var(--foreground) 3%, transparent), inset 0 -2px 0 color-mix(in srgb, var(--primary) 52%, transparent)",
  },
  "underline-rail": {
    sentenceBackground: "transparent",
    sentenceUnderline: "color-mix(in srgb, var(--primary) 24%, transparent)",
    wordBackground: "transparent",
    wordColor: "var(--foreground)",
    wordUnderline: "color-mix(in srgb, var(--primary) 82%, transparent)",
    overlayBackground: "transparent",
    overlayBorder: "0 solid transparent",
    overlayRadius: "0",
    overlayShadow: "inset 0 -2px 0 color-mix(in srgb, var(--primary) 82%, transparent)",
    codeBackground: "transparent",
    codeBorder: "1px solid transparent",
    codeRadius: "0.75rem",
    codeShadow:
      "inset 0 -3px 0 color-mix(in srgb, var(--primary) 82%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--primary) 14%, transparent)",
  },
  "cursor-capsule": {
    sentenceBackground: "color-mix(in srgb, var(--primary) 5%, transparent)",
    sentenceUnderline: "color-mix(in srgb, var(--primary) 26%, transparent)",
    wordBackground: "color-mix(in srgb, var(--primary) 9%, transparent)",
    wordColor: "var(--foreground)",
    wordUnderline: "color-mix(in srgb, var(--primary) 62%, transparent)",
    overlayBackground: "color-mix(in srgb, var(--primary) 12%, transparent)",
    overlayBorder: "1px solid color-mix(in srgb, var(--primary) 18%, transparent)",
    overlayRadius: "4px",
    overlayShadow: "inset 0 -1px 0 color-mix(in srgb, var(--primary) 56%, transparent)",
    codeBackground: "color-mix(in srgb, var(--primary) 5%, transparent)",
    codeBorder: "1px solid color-mix(in srgb, var(--primary) 28%, transparent)",
    codeRadius: "0.75rem",
    codeShadow:
      "inset 0 0 0 9999px color-mix(in srgb, var(--primary) 5%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--primary) 62%, transparent), 0 12px 30px -24px color-mix(in srgb, var(--primary) 72%, transparent)",
  },
  "left-marker": {
    sentenceBackground: "color-mix(in srgb, var(--primary) 4%, transparent)",
    sentenceUnderline: "transparent",
    wordBackground: "transparent",
    wordColor: "var(--foreground)",
    wordUnderline: "color-mix(in srgb, var(--primary) 68%, transparent)",
    overlayBackground: "transparent",
    overlayBorder: "0 solid transparent",
    overlayRadius: "0",
    overlayShadow: "inset 0 -1px 0 color-mix(in srgb, var(--primary) 64%, transparent)",
    codeBackground: "color-mix(in srgb, var(--primary) 3%, transparent)",
    codeBorder: "1px solid color-mix(in srgb, var(--primary) 18%, transparent)",
    codeRadius: "0.75rem",
    codeShadow:
      "inset 0 1px 0 color-mix(in srgb, var(--primary) 22%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--primary) 64%, transparent)",
  },
  "muted-amber": {
    sentenceBackground: "oklch(0.72 0.045 82 / 0.08)",
    sentenceUnderline: "oklch(0.72 0.045 82 / 0.22)",
    wordBackground: "oklch(0.72 0.045 82 / 0.13)",
    wordColor: "var(--foreground)",
    wordUnderline: "oklch(0.74 0.075 82 / 0.62)",
    overlayBackground: "oklch(0.72 0.045 82 / 0.12)",
    overlayBorder: "1px solid oklch(0.74 0.06 82 / 0.2)",
    overlayRadius: "4px",
    overlayShadow: "inset 0 -1px 0 oklch(0.74 0.075 82 / 0.54)",
    codeBackground: "oklch(0.72 0.045 82 / 0.06)",
    codeBorder: "1px solid oklch(0.74 0.06 82 / 0.24)",
    codeRadius: "0.75rem",
    codeShadow:
      "inset 0 0 0 9999px oklch(0.74 0.075 82 / 0.05), inset 0 -1px 0 oklch(0.74 0.075 82 / 0.56), 0 12px 30px -24px oklch(0.74 0.075 82 / 0.64)",
  },
};

export interface ReadAloudChunk {
  readonly id: string;
  readonly kind: "speech" | "silent";
  readonly block: HTMLElement;
  readonly text: string;
  readonly speechText: string;
  readonly speechTokenAlignments: readonly SpeechTokenAlignment[];
  readonly atomicSpans?: readonly TextSpan[];
  readonly blockStartOffset: number;
  readonly holdMs?: number;
  readonly silentReason?: "code-block";
  readonly silentLabel?: string;
  readonly codeFocusKey?: string;
}

interface ActiveHighlightState {
  readonly chunkId: string;
  readonly sentenceIndex: number;
  readonly groupIndex: number;
  readonly wordIndex: number;
  readonly updatedAt: number;
}

interface ReadAloudSpeechHighlightTarget {
  readonly kind: "speech";
  readonly chunkId: string;
  readonly sentenceIndex: number;
  readonly groupIndex: number;
  readonly wordIndex: number;
  readonly expectedSentenceText: string;
  readonly expectedGroupText: string | null;
}

interface ReadAloudSilentCodeHighlightTarget {
  readonly kind: "silent-code";
  readonly chunkId: string;
  readonly codeFocusKey: string | null;
}

interface ReadAloudClearHighlightTarget {
  readonly kind: "clear";
}

type ReadAloudHighlightTarget =
  | ReadAloudSpeechHighlightTarget
  | ReadAloudSilentCodeHighlightTarget
  | ReadAloudClearHighlightTarget;

interface ReadAloudHighlightCommitResult {
  readonly committed: boolean;
  readonly sentenceRange: Range | null;
  readonly reason?: string;
}

interface ReadAloudHighlightRejection {
  readonly reason: string;
  readonly chunkId?: string;
  readonly target?: unknown;
  readonly expectedText?: string | null;
  readonly actualText?: string | null;
}

interface PreparedAudioChunk {
  readonly audioUrl: string;
  readonly timings: readonly ReadAloudTimingChunk[];
  readonly rawCacheKey: string;
  readonly renderedWpm: number;
  readonly tempoFactor: number;
  readonly wordCount: number;
}

interface ReadAloudTimingTrace {
  readonly id: number;
  readonly startedAt: number;
  lastAt: number;
}

interface ThreadReadAloudContextValue {
  readonly onMarkdownContextMenu: (
    event: ReactMouseEvent<HTMLElement>,
    root: HTMLElement | null,
  ) => void;
  readonly active: boolean;
  readonly canResume: boolean;
  readonly isLoading: boolean;
  readonly isPlaying: boolean;
  readonly isActiveProgress: boolean;
  readonly mode: ReadAloudMode;
  readonly activeCodeFocusKey: string | null;
  readonly snapshot: AudioPlaybackSnapshot | null;
  readonly silentLabel: string | null;
  readonly silentRemainingMs: number | null;
  readonly statusLabel: string;
  readonly targetWpm: number;
  readonly voice: string;
  readonly indicatorType: ReadAloudIndicatorType;
  readonly highlightVariant: ReadAloudHighlightVariant;
  readonly setTargetWpm: (wpm: number) => void;
  readonly setVoice: (voice: string) => void;
  readonly setIndicatorType: (indicatorType: ReadAloudIndicatorType) => void;
  readonly setHighlightVariant: (variant: ReadAloudHighlightVariant) => void;
  readonly stop: () => void;
  readonly skipCurrent: () => void;
  readonly togglePlayback: () => void;
}

const ThreadReadAloudContext = createContext<ThreadReadAloudContextValue | null>(null);

let nextReadAloudTimingTraceId = 1;
let nextReadAloudChunkId = 1;

export function useThreadReadAloudContext(): ThreadReadAloudContextValue | null {
  return use(ThreadReadAloudContext);
}

function isReadAloudHighlightVariant(value: string): value is ReadAloudHighlightVariant {
  return READ_ALOUD_HIGHLIGHT_STYLES.some((style) => style === value);
}

function applyReadAloudHighlightVariant(variant: ReadAloudHighlightVariant): void {
  const css = READ_ALOUD_HIGHLIGHT_VARIANT_CSS[variant];
  const root = document.documentElement;
  root.dataset.readAloudHighlightVariant = variant;
  root.style.setProperty("--t3-read-aloud-sentence-bg", css.sentenceBackground);
  root.style.setProperty("--t3-read-aloud-sentence-underline", css.sentenceUnderline);
  root.style.setProperty("--t3-read-aloud-word-bg", css.wordBackground);
  root.style.setProperty("--t3-read-aloud-word-color", css.wordColor);
  root.style.setProperty("--t3-read-aloud-word-underline", css.wordUnderline);
  root.style.setProperty("--t3-read-aloud-overlay-bg", css.overlayBackground);
  root.style.setProperty("--t3-read-aloud-overlay-border", css.overlayBorder);
  root.style.setProperty("--t3-read-aloud-overlay-radius", css.overlayRadius);
  root.style.setProperty("--t3-read-aloud-overlay-shadow", css.overlayShadow);
  root.style.setProperty("--t3-read-aloud-code-bg", css.codeBackground);
  root.style.setProperty("--t3-read-aloud-code-border", css.codeBorder);
  root.style.setProperty("--t3-read-aloud-code-radius", css.codeRadius);
  root.style.setProperty("--t3-read-aloud-code-shadow", css.codeShadow);

  const overlay = document.getElementById(WORD_HIGHLIGHT_OVERLAY_ID);
  if (overlay instanceof HTMLDivElement) {
    overlay.dataset.variant = variant;
  }
}

function createReadAloudTimingTrace(): ReadAloudTimingTrace | null {
  if (!import.meta.env.DEV) return null;
  const now = performance.now();
  return {
    id: nextReadAloudTimingTraceId++,
    startedAt: now,
    lastAt: now,
  };
}

function markReadAloudTiming(trace: ReadAloudTimingTrace | null, label: string): void {
  if (!trace) return;
  const now = performance.now();
  console.debug(
    `[read-aloud timing #${trace.id}] ${label}: +${(now - trace.lastAt).toFixed(1)}ms, total ${(now - trace.startedAt).toFixed(1)}ms`,
  );
  trace.lastAt = now;
}

function isReadAloudSuperseded(cause: unknown): boolean {
  return cause instanceof Error && cause.message === "Read-aloud request superseded";
}

function hasVisibleClientRect(element: HTMLElement): boolean {
  return [...element.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0);
}

function resolveLiveCodeBlockForChunk(chunk: ReadAloudChunk): HTMLElement {
  if (chunk.kind !== "silent") return chunk.block;
  if (chunk.block.isConnected && hasVisibleClientRect(chunk.block)) return chunk.block;

  const text = chunk.text.trim();
  if (text.length === 0) return chunk.block;

  const candidates = [
    ...document.querySelectorAll<HTMLElement>(
      ".chat-markdown-codeblock pre, .chat-markdown-codeblock .shiki, pre.shiki, pre",
    ),
  ];

  return (
    candidates.find(
      (candidate) =>
        !candidate.closest(READ_ALOUD_EXCLUDED_CONTAINER_SELECTOR) &&
        candidate.textContent?.trim() === text &&
        hasVisibleClientRect(candidate),
    ) ??
    candidates.find(
      (candidate) =>
        !candidate.closest(READ_ALOUD_EXCLUDED_CONTAINER_SELECTOR) &&
        candidate.textContent?.trim() === text,
    ) ??
    chunk.block
  );
}

function readAloudStatusLabel(mode: ReadAloudMode): string {
  switch (mode) {
    case "loading":
      return "Loading";
    case "playing":
      return "Reading";
    case "paused":
      return "Paused";
    case "showing-code":
      return "Reading";
    case "code-paused":
      return "Paused";
    case "error":
      return "Error";
    case "idle":
      return "Ready";
  }
}

function sentenceTextForReadAloudMenuChunk(chunk: ReadAloudChunk): string {
  const blockText = chunk.block.textContent ?? "";
  const spans = sentenceSpans(blockText);
  const matchingSpan =
    spans.find(
      (span) => span.start <= chunk.blockStartOffset && chunk.blockStartOffset < span.end,
    ) ?? spans.find((span) => chunk.blockStartOffset < span.end);
  if (!matchingSpan) return chunk.text;
  return blockText.slice(matchingSpan.start, matchingSpan.end).trim() || chunk.text;
}

function selectedTextInReadAloudRoot(root: HTMLElement): string | null {
  if (typeof window === "undefined") return null;
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!selection || !text || selection.rangeCount === 0) return null;

  for (let index = 0; index < selection.rangeCount; index++) {
    const range = selection.getRangeAt(index);
    const ancestor = range.commonAncestorContainer;
    const element = ancestor instanceof HTMLElement ? ancestor : ancestor.parentElement;
    if (element && root.contains(element)) return text;
  }

  return null;
}

function wordTextForReadAloudMenuChunk(chunk: ReadAloudChunk): string {
  const firstWord = wordSpans(chunk.text, readAloudSegmentationOptions(chunk))[0];
  return firstWord ? chunk.text.slice(firstWord.start, firstWord.end).trim() : chunk.text.trim();
}

function paragraphTextForReadAloudMenuChunk(chunk: ReadAloudChunk): string {
  return (chunk.block.textContent ?? "").trim() || chunk.text;
}

function copyReadAloudContextText(text: string): void {
  if (typeof window === "undefined" || !navigator.clipboard?.writeText) return;
  void navigator.clipboard.writeText(text).catch(() => undefined);
}

export function ReadAloudHeaderControl() {
  const readAloud = useThreadReadAloudContext();
  if (!readAloud) return null;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Toggle
                  className={cn(
                    "shrink-0",
                    readAloud.active &&
                      "border-primary/45 bg-primary/12 text-primary hover:bg-primary/16 data-pressed:bg-primary/18",
                  )}
                  pressed={readAloud.isActiveProgress}
                  aria-label="Read-aloud controls"
                  variant="outline"
                  size="xs"
                >
                  <HeadphonesIcon className="size-3" />
                </Toggle>
              }
            />
          }
        />
        <TooltipPopup side="bottom">Read-aloud controls</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" side="bottom" sideOffset={8} className="w-64 p-0">
        <div className="grid gap-3 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">Read aloud</div>
              <div className="text-[11px] text-muted-foreground">{readAloud.statusLabel}</div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                disabled={!readAloud.active || readAloud.isLoading}
                aria-label={readAloud.isActiveProgress ? "Pause" : "Play"}
                title={readAloud.isActiveProgress ? "Pause" : "Resume"}
                onClick={readAloud.togglePlayback}
              >
                {readAloud.isActiveProgress ? (
                  <PauseIcon className="size-3.5" />
                ) : (
                  <PlayIcon className="size-3.5" />
                )}
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Stop"
                onClick={readAloud.stop}
              >
                <SquareIcon className="size-3.5" />
              </Button>
            </div>
          </div>
          <label className="grid gap-1.5 text-[11px] text-muted-foreground">
            <span>WPM</span>
            <div className="grid grid-cols-[1fr_3.25rem] items-center gap-2">
              <input
                className="accent-primary"
                type="range"
                min={MIN_WPM}
                max={MAX_WPM}
                step={10}
                value={readAloud.targetWpm}
                onChange={(event) => readAloud.setTargetWpm(Number(event.currentTarget.value))}
              />
              <input
                className="h-7 rounded-md border border-border/70 bg-background px-1.5 text-right text-[11px] text-foreground outline-none focus:border-primary/70"
                type="number"
                min={MIN_WPM}
                max={MAX_WPM}
                step={10}
                value={readAloud.targetWpm}
                onChange={(event) => readAloud.setTargetWpm(Number(event.currentTarget.value))}
              />
            </div>
          </label>
          <label className="grid gap-1.5 text-[11px] text-muted-foreground">
            <span>Voice</span>
            <Select
              value={readAloud.voice}
              onValueChange={(value) => {
                if (value !== null) readAloud.setVoice(value);
              }}
              items={READ_ALOUD_VOICE_SELECT_ITEMS}
            >
              <SelectTrigger size="xs" className="w-full" aria-label="Voice">
                <SelectValue>{readAloudVoiceLabel(readAloud.voice)}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {VOICES.map((voiceOption) => (
                    <SelectItem hideIndicator key={voiceOption} value={voiceOption}>
                      {readAloudVoiceLabel(voiceOption)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectPopup>
            </Select>
          </label>
          <label className="grid gap-1.5 text-[11px] text-muted-foreground">
            <span>Indicator</span>
            <Select
              value={readAloud.indicatorType}
              onValueChange={(value) => {
                if (value === "dot" || value === "rail" || value === "icon") {
                  readAloud.setIndicatorType(value);
                }
              }}
            >
              <SelectTrigger size="xs" className="w-full" aria-label="Indicator type">
                <SelectValue>{READ_ALOUD_INDICATOR_LABELS[readAloud.indicatorType]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="dot">
                  {READ_ALOUD_INDICATOR_LABELS.dot}
                </SelectItem>
                <SelectItem hideIndicator value="rail">
                  {READ_ALOUD_INDICATOR_LABELS.rail}
                </SelectItem>
                <SelectItem hideIndicator value="icon">
                  {READ_ALOUD_INDICATOR_LABELS.icon}
                </SelectItem>
              </SelectPopup>
            </Select>
          </label>
          <label className="grid gap-1.5 text-[11px] text-muted-foreground">
            <span>Highlight</span>
            <select
              className="h-7 rounded-md border border-border/70 bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary/70"
              aria-label="Highlight style"
              value={readAloud.highlightVariant}
              onChange={(event) => {
                const next = event.currentTarget.value;
                if (isReadAloudHighlightVariant(next)) {
                  readAloud.setHighlightVariant(next);
                }
              }}
            >
              {READ_ALOUD_HIGHLIGHT_SELECT_ITEMS.map((variant) => (
                <option key={variant.value} value={variant.value}>
                  {variant.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ReadAloudStateTracker() {
  const readAloud = useThreadReadAloudContext();
  const active = readAloud?.active ?? false;
  if (!active) return null;

  const targetWpm = readAloud?.targetWpm ?? DEFAULT_TARGET_WPM;
  const voice = readAloud?.voice ?? DEFAULT_VOICE;
  const indicatorType = readAloud?.indicatorType ?? DEFAULT_READ_ALOUD_INDICATOR_TYPE;
  const indicatorLabel = readAloud?.statusLabel ?? "Read aloud";
  const isActiveProgress = readAloud?.isActiveProgress ?? false;
  const showStatusText = readAloud?.mode === "loading" || readAloud?.mode === "error";
  const audioProgress =
    readAloud?.snapshot?.durationSeconds && readAloud.snapshot.durationSeconds > 0
      ? Math.min(
          1,
          Math.max(0, readAloud.snapshot.currentTimeSeconds / readAloud.snapshot.durationSeconds),
        )
      : null;
  const progressPercent =
    readAloud?.mode === "loading" ? null : readAloud?.mode === "showing-code" ? 1 : audioProgress;
  const indicator =
    indicatorType === "rail" ? (
      <span
        className={cn(
          "h-3.5 w-0.5 shrink-0 rounded-full",
          isActiveProgress ? "bg-primary" : "bg-muted-foreground/45",
        )}
        aria-label={indicatorLabel}
      />
    ) : indicatorType === "icon" ? (
      <HeadphonesIcon
        className={cn(
          "size-3.5 shrink-0",
          isActiveProgress ? "text-primary" : "text-muted-foreground/70",
        )}
        aria-label={indicatorLabel}
      />
    ) : (
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          isActiveProgress
            ? "bg-primary shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_16%,transparent)]"
            : "bg-muted-foreground/45",
        )}
        aria-label={indicatorLabel}
      />
    );

  return (
    <div className="pointer-events-none absolute right-3 bottom-8 left-3 z-30 flex justify-center text-[11px]">
      <div className="pointer-events-auto relative flex h-6 w-fit max-w-[calc(100vw-1.5rem)] items-center gap-1 overflow-hidden rounded-lg border border-border/55 bg-popover/95 px-1.5 shadow-xs/10 backdrop-blur">
        <span
          className={cn(
            "pointer-events-none absolute inset-x-1 bottom-0 h-px origin-left rounded-full bg-primary/55",
            readAloud?.mode === "loading" ? "animate-read-aloud-loading-strip" : "",
          )}
          style={
            progressPercent === null
              ? undefined
              : {
                  transform: `scaleX(${progressPercent})`,
                }
          }
        />
        <div className="flex min-w-0 items-center gap-1">
          {indicator}
          {showStatusText ? (
            <span className="max-w-[8.5rem] truncate px-1 text-[10px] font-medium text-foreground/80">
              {readAloud?.statusLabel}
            </span>
          ) : null}
          <ReadAloudWpmPopoverControl
            value={targetWpm}
            onChange={(nextWpm) => readAloud?.setTargetWpm(nextWpm)}
            variant="overlay"
            popupSide="top"
            popupAlign="center"
          />
          <Select
            value={voice}
            onValueChange={(value) => {
              if (value !== null) readAloud?.setVoice(value);
            }}
            items={READ_ALOUD_VOICE_SELECT_ITEMS}
          >
            <SelectTrigger
              variant="ghost"
              size="xs"
              className="h-5 w-[4.9rem] rounded-md border-transparent bg-transparent px-1.5 text-[10px] text-foreground hover:bg-accent"
              aria-label="Voice"
            >
              <HeadphonesIcon className="size-3 text-muted-foreground" />
              <span className="min-w-0 truncate">{readAloudVoiceLabel(voice)}</span>
            </SelectTrigger>
            <SelectPopup side="top" align="center" sideOffset={8}>
              <SelectGroup>
                <SelectGroupLabel>Voice</SelectGroupLabel>
                {VOICES.map((voiceOption) => (
                  <SelectItem key={voiceOption} value={voiceOption}>
                    {readAloudVoiceLabel(voiceOption)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!readAloud || readAloud.isLoading}
            aria-label={readAloud?.isActiveProgress ? "Pause" : "Play"}
            title={readAloud?.isActiveProgress ? "Pause" : "Resume"}
            onClick={readAloud?.togglePlayback}
          >
            {readAloud?.isActiveProgress ? (
              <PauseIcon className="size-3.5" />
            ) : (
              <PlayIcon className="size-3.5" />
            )}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!readAloud}
            aria-label="Stop"
            onClick={readAloud?.stop}
          >
            <SquareIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(EXCLUDED_SELECTOR) !== null;
}

function getCaretRangeFromPoint(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return range;
  const position = doc.caretPositionFromPoint?.(x, y);
  if (!position) return null;
  const nextRange = document.createRange();
  nextRange.setStart(position.offsetNode, position.offset);
  nextRange.collapse(true);
  return nextRange;
}

function textOffsetInBlock(block: HTMLElement, node: Node, nodeOffset: number): number | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    const current = walker.currentNode;
    const textLength = current.textContent?.length ?? 0;
    if (current === node) {
      return offset + Math.min(nodeOffset, textLength);
    }
    offset += textLength;
  }
  return null;
}

function inlineCodeSpansForReadAloudChunk(input: {
  readonly block: HTMLElement;
  readonly blockStartOffset: number;
  readonly textLength: number;
}): TextSpan[] {
  if (
    input.textLength <= 0 ||
    input.block.tagName?.toLowerCase() === "pre" ||
    typeof input.block.querySelectorAll !== "function"
  )
    return [];
  const chunkStart = input.blockStartOffset;
  const chunkEnd = chunkStart + input.textLength;
  const spans: TextSpan[] = [];

  for (const code of input.block.querySelectorAll<HTMLElement>("code")) {
    if (code.closest("pre")) continue;
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let firstText: Node | null = null;
    let lastText: Node | null = null;
    while (walker.nextNode()) {
      firstText ??= walker.currentNode;
      lastText = walker.currentNode;
    }
    if (!firstText || !lastText) continue;
    const start = textOffsetInBlock(input.block, firstText, 0);
    const end = textOffsetInBlock(input.block, lastText, lastText.textContent?.length ?? 0);
    if (start === null || end === null || end <= start) continue;
    const clippedStart = Math.max(start, chunkStart);
    const clippedEnd = Math.min(end, chunkEnd);
    if (clippedEnd > clippedStart) {
      spans.push({ start: clippedStart - chunkStart, end: clippedEnd - chunkStart });
    }
  }

  return spans;
}

function readAloudChunkAtomicSpans(
  block: HTMLElement,
  blockStartOffset: number,
  textLength: number,
): TextSpan[] {
  return inlineCodeSpansForReadAloudChunk({ block, blockStartOffset, textLength });
}

function wordStartAt(text: string, offset: number): number | null {
  const clampedOffset = Math.min(text.length, Math.max(0, offset));
  const wordRegex = /[\p{L}\p{N}](?:[\p{L}\p{N}'-]*[\p{L}\p{N}])?/gu;
  for (const match of text.matchAll(wordRegex)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (clampedOffset >= start && clampedOffset <= end) {
      return start;
    }
    if (start > clampedOffset) {
      return start;
    }
  }
  return null;
}

function wordCount(text: string): number {
  return [...text.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}'-]*[\p{L}\p{N}])?/gu)].length;
}

function readAloudSegmentationOptions(chunk: ReadAloudChunk): {
  readonly atomicSpans?: readonly TextSpan[];
} {
  return chunk.atomicSpans ? { atomicSpans: chunk.atomicSpans } : {};
}

function nearestDisplayWordIndex(
  displayText: string,
  displayStart: number,
  atomicSpans: readonly TextSpan[] = [],
): number | null {
  const displayWords = wordSpans(displayText, { atomicSpans });
  if (displayWords.length === 0) return null;
  const containingIndex = displayWords.findIndex(
    (word) => displayStart >= word.start && displayStart < word.end,
  );
  if (containingIndex >= 0) return containingIndex;
  const afterIndex = displayWords.findIndex((word) => word.start >= displayStart);
  if (afterIndex >= 0) return afterIndex;
  return displayWords.length - 1;
}

export function displayWordIndexForReadAloudTimings(input: {
  readonly displayText: string;
  readonly timings: readonly ReadAloudTimingChunk[];
  readonly speechTokenAlignments: readonly SpeechTokenAlignment[];
  readonly currentTime: number;
  readonly atomicSpans?: readonly TextSpan[];
}): number | null {
  const { displayText, timings, speechTokenAlignments, currentTime, atomicSpans = [] } = input;
  const displayWords = wordSpans(displayText, { atomicSpans });
  if (displayWords.length === 0 || timings.length === 0 || speechTokenAlignments.length === 0) {
    return null;
  }
  const usableTimings = timings
    .filter(
      (timing) =>
        Number.isFinite(timing.start) &&
        Number.isFinite(timing.end) &&
        timing.end >= timing.start &&
        wordCount(timing.text) > 0,
    )
    .toSorted((left, right) => left.start - right.start);
  if (usableTimings.length === 0) return null;

  let timingIndex = usableTimings.findIndex(
    (timing) => currentTime >= timing.start && currentTime < timing.end,
  );
  if (timingIndex < 0) {
    const lastTiming = usableTimings.at(-1);
    if (lastTiming && currentTime >= lastTiming.end) return null;
    timingIndex = usableTimings.findLastIndex((timing) => currentTime >= timing.end);
    if (timingIndex < 0) timingIndex = 0;
  }

  const timingWordCounts = usableTimings.map((timing) => wordCount(timing.text));
  const totalTimingWords = timingWordCounts.reduce((sum, count) => sum + count, 0);
  if (totalTimingWords <= 0) return null;

  const activeTiming = usableTimings[timingIndex]!;
  const activeWordCount = timingWordCounts[timingIndex]!;
  const activeDuration = Math.max(0, activeTiming.end - activeTiming.start);
  const activeProgress =
    activeDuration > 0
      ? Math.min(0.999999, Math.max(0, (currentTime - activeTiming.start) / activeDuration))
      : 0;
  const wordsBeforeActive = timingWordCounts
    .slice(0, timingIndex)
    .reduce((sum, count) => sum + count, 0);
  const speechTokenIndex = wordsBeforeActive + Math.floor(activeProgress * activeWordCount);

  const alignment = speechTokenAlignments[speechTokenIndex];
  if (!alignment) return null;
  return nearestDisplayWordIndex(displayText, alignment.displayStart, atomicSpans);
}

export function wordIndexForReadAloudTimings(
  displayText: string,
  timings: readonly ReadAloudTimingChunk[],
  currentTime: number,
): number | null {
  const displayWords = wordSpans(displayText);
  if (displayWords.length === 0 || timings.length === 0) return null;
  const usableTimings = timings
    .filter(
      (timing) =>
        Number.isFinite(timing.start) && Number.isFinite(timing.end) && timing.end >= timing.start,
    )
    .toSorted((left, right) => left.start - right.start);
  if (usableTimings.length === 0) return null;

  let timingIndex = usableTimings.findIndex(
    (timing) => currentTime >= timing.start && currentTime < timing.end,
  );
  if (timingIndex < 0) {
    timingIndex = usableTimings.findLastIndex((timing) => currentTime >= timing.end);
    if (timingIndex < 0) timingIndex = 0;
  }

  const timingWordCounts = usableTimings.map((timing) => wordCount(timing.text));
  const totalTimingWords = timingWordCounts.reduce((sum, count) => sum + count, 0);
  if (totalTimingWords <= 0) return null;

  const activeTiming = usableTimings[timingIndex]!;
  const activeWordCount = timingWordCounts[timingIndex]!;
  const activeDuration = Math.max(0, activeTiming.end - activeTiming.start);
  const activeProgress =
    activeDuration > 0
      ? Math.min(0.999999, Math.max(0, (currentTime - activeTiming.start) / activeDuration))
      : 0;
  const wordsBeforeActive = timingWordCounts
    .slice(0, timingIndex)
    .reduce((sum, count) => sum + count, 0);
  const timingWordIndex = wordsBeforeActive + Math.floor(activeProgress * activeWordCount);

  if (Math.abs(totalTimingWords - displayWords.length) <= 2) {
    return Math.min(displayWords.length - 1, timingWordIndex);
  }

  const timingProgress = timingWordIndex / totalTimingWords;
  return Math.min(displayWords.length - 1, Math.floor(timingProgress * displayWords.length));
}

function rangeForTextOffsets(
  block: HTMLElement,
  startOffset: number,
  endOffset: number,
): Range | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let startNode: Node | null = null;
  let startNodeOffset = 0;
  let endNode: Node | null = null;
  let endNodeOffset = 0;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const length = node.textContent?.length ?? 0;
    const nextOffset = offset + length;
    if (!startNode && startOffset >= offset && startOffset <= nextOffset) {
      startNode = node;
      startNodeOffset = startOffset - offset;
    }
    if (endOffset >= offset && endOffset <= nextOffset) {
      endNode = node;
      endNodeOffset = endOffset - offset;
      break;
    }
    offset = nextOffset;
  }

  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startNodeOffset);
  range.setEnd(endNode, endNodeOffset);
  return range;
}

function normalizeHighlightTextForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function logReadAloudHighlightRejection(rejection: ReadAloudHighlightRejection): void {
  if (!import.meta.env.DEV) return;
  console.debug("[read-aloud] rejected highlight target", rejection);
}

function validateReadAloudRange(input: {
  readonly range: Range | null;
  readonly expectedText: string;
  readonly allowPartialTextMatch?: boolean;
}): Range | null {
  const expectedText = normalizeHighlightTextForCompare(input.expectedText);
  if (expectedText.length === 0) {
    logReadAloudHighlightRejection({ reason: "empty-expected-text", expectedText });
    return null;
  }
  const range = input.range;
  if (!range) {
    logReadAloudHighlightRejection({ reason: "missing-dom-range", expectedText });
    return null;
  }
  if (range.collapsed) {
    logReadAloudHighlightRejection({ reason: "collapsed-dom-range", expectedText });
    return null;
  }
  const actualText = normalizeHighlightTextForCompare(range.toString());
  if (actualText.length === 0) {
    logReadAloudHighlightRejection({ reason: "empty-dom-range", expectedText, actualText });
    return null;
  }
  if (!firstVisibleRangeRect(range)) {
    logReadAloudHighlightRejection({ reason: "invisible-dom-range", expectedText, actualText });
    return null;
  }
  const matches = input.allowPartialTextMatch
    ? actualText.includes(expectedText) || expectedText.includes(actualText)
    : actualText === expectedText;
  if (!matches) {
    logReadAloudHighlightRejection({ reason: "text-mismatch", expectedText, actualText });
    return null;
  }
  return range;
}

function clearReadAloudHighlightDom(setActiveCodeFocusKey: (key: string | null) => void): void {
  setActiveCodeFocusKey(null);
  const highlights = (CSS as typeof CSS & { highlights?: Map<string, Highlight> }).highlights;
  highlights?.delete(HIGHLIGHT_NAME);
  highlights?.delete(WORD_HIGHLIGHT_NAME);
  updateAnimatedWordHighlight(null);
}

function buildSpeechHighlightTarget(input: {
  readonly chunk: ReadAloudChunk;
  readonly sentenceIndex: number;
  readonly groupIndex: number;
  readonly wordIndex: number;
  readonly groups: readonly HighlightGroup[];
}): ReadAloudSpeechHighlightTarget | null {
  const { chunk, sentenceIndex, groupIndex, wordIndex, groups } = input;
  if (chunk.kind !== "speech") return null;
  const sentence = sentenceSpans(chunk.text)[sentenceIndex];
  if (!sentence) {
    logReadAloudHighlightRejection({
      reason: "missing-sentence",
      chunkId: chunk.id,
      target: input,
    });
    return null;
  }
  const group = groups[groupIndex];
  if (!group) {
    logReadAloudHighlightRejection({
      reason: "missing-group",
      chunkId: chunk.id,
      target: input,
    });
    return null;
  }
  if (group.sentenceIndex !== sentenceIndex) {
    logReadAloudHighlightRejection({
      reason: "group-sentence-mismatch",
      chunkId: chunk.id,
      target: input,
    });
    return null;
  }
  const expectedSentenceText = chunk.text.slice(sentence.start, sentence.end).trim();
  const expectedGroupText = chunk.text.slice(group.start, group.end).trim();
  if (expectedSentenceText.length === 0 || expectedGroupText.length === 0) {
    logReadAloudHighlightRejection({
      reason: "empty-expected-text",
      chunkId: chunk.id,
      target: input,
      expectedText: expectedSentenceText.length === 0 ? expectedSentenceText : expectedGroupText,
    });
    return null;
  }
  return {
    kind: "speech",
    chunkId: chunk.id,
    sentenceIndex,
    groupIndex,
    wordIndex,
    expectedSentenceText,
    expectedGroupText,
  };
}

export function shouldScrollReadAloudRectIntoView(
  rect: Pick<DOMRect, "top" | "bottom">,
  containerRect: Pick<DOMRect, "top" | "bottom" | "height">,
  options: {
    readonly topGuardPx?: number;
    readonly bottomTriggerRatio?: number;
  } = {},
): boolean {
  const topGuard = containerRect.top + (options.topGuardPx ?? READ_ALOUD_SCROLL_TOP_GUARD_PX);
  const bottomTrigger =
    containerRect.top +
    containerRect.height * (options.bottomTriggerRatio ?? READ_ALOUD_SCROLL_BOTTOM_RATIO);

  return rect.top < topGuard || rect.bottom > bottomTrigger;
}

export function computeReadAloudScrollDelta(input: {
  readonly rect: Pick<DOMRect, "top" | "bottom" | "height">;
  readonly containerRect: Pick<DOMRect, "top" | "height">;
  readonly targetRatio?: number;
}): number {
  const targetCenter =
    input.containerRect.top +
    input.containerRect.height * (input.targetRatio ?? READ_ALOUD_SCROLL_TARGET_RATIO);
  const rectCenter = input.rect.top + input.rect.height / 2;

  return rectCenter - targetCenter;
}

function firstVisibleRangeRect(range: Range | null): DOMRect | null {
  if (!range) return null;
  return (
    [...range.getClientRects()].find((candidate) => candidate.width > 0 && candidate.height > 0) ??
    null
  );
}

function resolveReadAloudScrollContainer(block: HTMLElement): HTMLElement | null {
  return (
    block.closest<HTMLElement>(`${READ_ALOUD_THREAD_SCOPE_SELECTOR} .overscroll-y-contain`) ??
    block.closest<HTMLElement>(".overscroll-y-contain")
  );
}

function elementFromRange(range: Range): HTMLElement | null {
  const container =
    range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  return container instanceof HTMLElement ? container : null;
}

function isRectInsideReadAloudViewport(range: Range, rect: DOMRect): boolean {
  const element = elementFromRange(range);
  const container = element ? resolveReadAloudScrollContainer(element) : null;
  const viewportRect = container?.getBoundingClientRect();
  const viewportTop = viewportRect?.top ?? 0;
  const viewportBottom =
    viewportRect?.bottom ?? (window.innerHeight || document.documentElement.clientHeight);
  const verticalSlackPx = 2;

  return rect.bottom > viewportTop + verticalSlackPx && rect.top < viewportBottom - verticalSlackPx;
}

function scrollReadAloudRangeIntoView(input: {
  readonly range: Range | null;
  readonly block: HTMLElement;
  readonly reason: "speech" | "silent";
}): void {
  const rect = firstVisibleRangeRect(input.range) ?? input.block.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  const container = resolveReadAloudScrollContainer(input.block);
  if (container) {
    const containerRect = container.getBoundingClientRect();
    if (!shouldScrollReadAloudRectIntoView(rect, containerRect)) return;
    const delta = computeReadAloudScrollDelta({ rect, containerRect });
    container.scrollBy({ top: delta, behavior: "smooth" });
    return;
  }

  input.block.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
}

function rejectReadAloudHighlight(input: {
  readonly reason: string;
  readonly target: ReadAloudHighlightTarget;
  readonly clearPolicy: "clear" | "hold-previous";
  readonly setActiveCodeFocusKey: (key: string | null) => void;
  readonly expectedText?: string | null;
  readonly actualText?: string | null;
}): ReadAloudHighlightCommitResult {
  logReadAloudHighlightRejection({
    reason: input.reason,
    target: input.target,
    ...(input.expectedText !== undefined ? { expectedText: input.expectedText } : {}),
    ...(input.actualText !== undefined ? { actualText: input.actualText } : {}),
  });
  if (input.clearPolicy === "clear") {
    clearReadAloudHighlightDom(input.setActiveCodeFocusKey);
  }
  return { committed: false, sentenceRange: null, reason: input.reason };
}

function commitReadAloudHighlightTarget(input: {
  readonly target: ReadAloudHighlightTarget;
  readonly chunks: readonly ReadAloudChunk[];
  readonly currentChunkIndex: number;
  readonly previousTarget: ActiveHighlightState | null;
  readonly setActiveCodeFocusKey: (key: string | null) => void;
  readonly groups?: readonly HighlightGroup[];
  readonly clearPolicy: "clear" | "hold-previous";
  readonly instantOverlay?: boolean;
}): ReadAloudHighlightCommitResult {
  const { target, chunks, currentChunkIndex, setActiveCodeFocusKey, clearPolicy } = input;
  if (target.kind === "clear") {
    clearReadAloudHighlightDom(setActiveCodeFocusKey);
    return { committed: true, sentenceRange: null };
  }

  const chunk = chunks[currentChunkIndex];
  if (!chunk) {
    return rejectReadAloudHighlight({
      reason: "missing-chunk",
      target,
      clearPolicy,
      setActiveCodeFocusKey,
    });
  }
  if (chunk.id !== target.chunkId) {
    return rejectReadAloudHighlight({
      reason: "stale-chunk",
      target,
      clearPolicy,
      setActiveCodeFocusKey,
    });
  }

  const highlights = (CSS as typeof CSS & { highlights?: Map<string, Highlight> }).highlights;

  if (target.kind === "silent-code") {
    setActiveCodeFocusKey(target.codeFocusKey);
    highlights?.delete(WORD_HIGHLIGHT_NAME);
    highlights?.delete(HIGHLIGHT_NAME);
    updateAnimatedWordHighlight(null);
    return { committed: true, sentenceRange: null };
  }

  if (chunk.kind !== "speech") {
    return rejectReadAloudHighlight({
      reason: "stale-chunk",
      target,
      clearPolicy,
      setActiveCodeFocusKey,
    });
  }

  const sentence = sentenceSpans(chunk.text)[target.sentenceIndex];
  const group =
    input.groups?.[target.groupIndex] ??
    buildReadAloudHighlightGroups(chunk.text)[target.groupIndex];
  if (!sentence) {
    return rejectReadAloudHighlight({
      reason: "missing-sentence",
      target,
      clearPolicy,
      setActiveCodeFocusKey,
    });
  }
  if (!group) {
    return rejectReadAloudHighlight({
      reason: "missing-group",
      target,
      clearPolicy,
      setActiveCodeFocusKey,
    });
  }
  if (group.sentenceIndex !== target.sentenceIndex) {
    return rejectReadAloudHighlight({
      reason: "group-sentence-mismatch",
      target,
      clearPolicy,
      setActiveCodeFocusKey,
    });
  }

  const sentenceRange = validateReadAloudRange({
    range: rangeForTextOffsets(
      chunk.block,
      chunk.blockStartOffset + sentence.start,
      chunk.blockStartOffset + sentence.end,
    ),
    expectedText: target.expectedSentenceText,
  });
  if (!sentenceRange) {
    return rejectReadAloudHighlight({
      reason: "missing-dom-range",
      target,
      clearPolicy,
      setActiveCodeFocusKey,
      expectedText: target.expectedSentenceText,
    });
  }

  const wordRange =
    target.expectedGroupText === null
      ? null
      : validateReadAloudRange({
          range: rangeForTextOffsets(
            chunk.block,
            chunk.blockStartOffset + group.start,
            chunk.blockStartOffset + group.end,
          ),
          expectedText: target.expectedGroupText,
        });
  if (target.expectedGroupText !== null && !wordRange) {
    return rejectReadAloudHighlight({
      reason: "missing-dom-range",
      target,
      clearPolicy,
      setActiveCodeFocusKey,
      expectedText: target.expectedGroupText,
    });
  }

  setActiveCodeFocusKey(null);
  highlights?.set(HIGHLIGHT_NAME, new Highlight(sentenceRange));
  if (wordRange && isWordHighlightRangeVisible(wordRange)) {
    highlights?.set(WORD_HIGHLIGHT_NAME, new Highlight(wordRange));
    updateAnimatedWordHighlight(wordRange, { instant: input.instantOverlay === true });
  } else {
    highlights?.delete(WORD_HIGHLIGHT_NAME);
    updateAnimatedWordHighlight(null, { instant: input.instantOverlay === true });
  }
  return { committed: true, sentenceRange };
}

function getAnimatedWordHighlightElement(container: HTMLElement): HTMLDivElement {
  const existing = document.getElementById(WORD_HIGHLIGHT_OVERLAY_ID);
  if (existing instanceof HTMLDivElement) {
    if (existing.parentElement !== container) container.append(existing);
    return existing;
  }
  const element = document.createElement("div");
  element.id = WORD_HIGHLIGHT_OVERLAY_ID;
  element.setAttribute("aria-hidden", "true");
  element.dataset.variant = DEFAULT_HIGHLIGHT_VARIANT;
  container.append(element);
  return element;
}

function updateAnimatedWordHighlight(
  range: Range | null,
  _options: { instant?: boolean } = {},
): void {
  if (!range) {
    const element = document.getElementById(WORD_HIGHLIGHT_OVERLAY_ID);
    if (element instanceof HTMLDivElement) element.dataset.visible = "false";
    return;
  }
  const rect = [...range.getClientRects()].find((candidate) => {
    return candidate.width > 0 && candidate.height > 0;
  });
  const elementForContainer = elementFromRange(range);
  const container = elementForContainer
    ? resolveReadAloudScrollContainer(elementForContainer)
    : null;
  if (!rect || !container || !isRectInsideReadAloudViewport(range, rect)) {
    const element = document.getElementById(WORD_HIGHLIGHT_OVERLAY_ID);
    if (element instanceof HTMLDivElement) element.dataset.visible = "false";
    return;
  }

  container.setAttribute(WORD_HIGHLIGHT_OVERLAY_HOST_ATTRIBUTE, "true");
  const element = getAnimatedWordHighlightElement(container);
  const variant = document.documentElement.dataset.readAloudHighlightVariant;
  element.dataset.variant = isReadAloudHighlightVariant(variant ?? "")
    ? variant
    : DEFAULT_HIGHLIGHT_VARIANT;

  const containerRect = container.getBoundingClientRect();
  const x = rect.left - containerRect.left + container.scrollLeft;
  const y = rect.top - containerRect.top + container.scrollTop;
  element.dataset.visible = "true";
  element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function isWordHighlightRangeVisible(range: Range): boolean {
  const rect = [...range.getClientRects()].find((candidate) => {
    return candidate.width > 0 && candidate.height > 0;
  });
  return rect !== undefined && isRectInsideReadAloudViewport(range, rect);
}

export function resolveStartChunk(
  event: ReactMouseEvent<HTMLElement>,
  root: HTMLElement,
): ReadAloudChunk | null {
  if (isEditableTarget(event.target)) return null;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.closest(READ_ALOUD_EXCLUDED_CONTAINER_SELECTOR)) return null;
  const block = resolveReadableBlock(target);
  if (
    !block ||
    !root.contains(block) ||
    block.closest("pre, code") ||
    block.closest(READ_ALOUD_EXCLUDED_CONTAINER_SELECTOR)
  )
    return null;
  const blockText = block.textContent ?? "";
  if (!blockText.trim()) return null;
  const range = getCaretRangeFromPoint(event.clientX, event.clientY);
  if (!range) return null;
  const offset = textOffsetInBlock(block, range.startContainer, range.startOffset);
  if (offset === null) return null;
  const startOffset = wordStartAt(blockText, offset);
  if (startOffset === null) return null;
  const rawText = blockText.slice(startOffset);
  const text = rawText.trim();
  const adjustedStartOffset = startOffset + (rawText.match(/^\s*/)?.[0].length ?? 0);
  const normalized = normalizeSpeechTextWithAlignment(text);
  const atomicSpans = readAloudChunkAtomicSpans(block, adjustedStartOffset, text.length);
  return text.length > 0 && normalized.speechText.length > 0
    ? {
        id: `read-aloud-chunk-${nextReadAloudChunkId++}`,
        kind: "speech",
        block,
        text,
        speechText: normalized.speechText,
        speechTokenAlignments: normalized.alignments,
        ...(atomicSpans.length > 0 ? { atomicSpans } : {}),
        blockStartOffset: adjustedStartOffset,
      }
    : null;
}

export function createSilentCodeChunk(block: HTMLElement): ReadAloudChunk | null {
  const rawText = block.textContent ?? "";
  const text = rawText.trim();
  if (text.length === 0) return null;
  const blockStartOffset = Math.max(0, rawText.search(/\S/));
  const metrics = computeReadAloudCodeHoldMetrics(text);
  const codeFocusKey = block.closest<HTMLElement>(".chat-markdown-codeblock")?.dataset
    .readAloudCodeFocusKey;
  return {
    id: `read-aloud-chunk-${nextReadAloudChunkId++}`,
    kind: "silent",
    block,
    text,
    speechText: "",
    speechTokenAlignments: [],
    blockStartOffset,
    holdMs: metrics.holdMs,
    silentReason: "code-block",
    silentLabel: metrics.label,
    ...(codeFocusKey ? { codeFocusKey } : {}),
  };
}

function resolveReadableBlock(target: HTMLElement | null): HTMLElement | null {
  if (target?.closest(READ_ALOUD_EXCLUDED_CONTAINER_SELECTOR)) return null;
  const block = target?.closest<HTMLElement>(READABLE_SELECTOR);
  if (!block) return null;
  return block.closest<HTMLElement>("li") ?? block;
}

function collectReadableBlocks(root: HTMLElement): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const markdownRoots = root.matches(READ_ALOUD_MARKDOWN_ROOT_SELECTOR)
    ? [root]
    : [...root.querySelectorAll<HTMLElement>(READ_ALOUD_MARKDOWN_ROOT_SELECTOR)];
  const candidateRoots = markdownRoots.length > 0 ? markdownRoots : [root];

  for (const candidateRoot of candidateRoots) {
    for (const candidate of candidateRoot.querySelectorAll<HTMLElement>(READABLE_SELECTOR)) {
      if (candidate.closest(READ_ALOUD_EXCLUDED_CONTAINER_SELECTOR)) continue;
      if (candidate.closest("code") && candidate.tagName.toLowerCase() !== "pre") continue;
      const block =
        candidate.tagName.toLowerCase() === "pre"
          ? candidate
          : (candidate.closest<HTMLElement>("li") ?? candidate);
      if (seen.has(block)) continue;
      if (block.closest(READ_ALOUD_EXCLUDED_CONTAINER_SELECTOR)) continue;
      if ((block.textContent?.trim().length ?? 0) === 0) continue;
      seen.add(block);
      blocks.push(block);
    }
  }
  return blocks;
}

function trimChunkText(input: {
  readonly block: HTMLElement;
  readonly rawText: string;
  readonly blockStartOffset: number;
}): ReadAloudChunk | null {
  const leading = input.rawText.match(/^\s*/)?.[0].length ?? 0;
  const trailing = input.rawText.match(/\s*$/)?.[0].length ?? 0;
  const text = input.rawText.slice(leading, input.rawText.length - trailing);
  const normalized = normalizeSpeechTextWithAlignment(text);
  const blockStartOffset = input.blockStartOffset + leading;
  const atomicSpans = readAloudChunkAtomicSpans(input.block, blockStartOffset, text.length);
  return text.length > 0
    ? {
        id: `read-aloud-chunk-${nextReadAloudChunkId++}`,
        kind: "speech",
        block: input.block,
        text,
        speechText: normalized.speechText,
        speechTokenAlignments: normalized.alignments,
        ...(atomicSpans.length > 0 ? { atomicSpans } : {}),
        blockStartOffset,
      }
    : null;
}

export function splitInitialChunkForFastStart(chunk: ReadAloudChunk): ReadAloudChunk[] {
  const firstSpan = sentenceSpans(chunk.text)[0];
  if (!firstSpan) return [chunk];
  const firstChunk = trimChunkText({
    block: chunk.block,
    rawText: chunk.text.slice(0, firstSpan.end),
    blockStartOffset: chunk.blockStartOffset,
  });
  const remainderChunk = trimChunkText({
    block: chunk.block,
    rawText: chunk.text.slice(firstSpan.end),
    blockStartOffset: chunk.blockStartOffset + firstSpan.end,
  });
  return [firstChunk, remainderChunk].filter(
    (candidate): candidate is ReadAloudChunk =>
      candidate !== null &&
      candidate.text.length > 0 &&
      candidate.speechText.length > 0 &&
      wordCount(candidate.text) > 0,
  );
}

export function collectChunks(root: HTMLElement, startChunk: ReadAloudChunk): ReadAloudChunk[] {
  const blocks = collectReadableBlocks(root);
  const startIndex = blocks.indexOf(startChunk.block);
  const nextBlocks = startIndex >= 0 ? blocks.slice(startIndex + 1) : [];
  const initialChunks =
    startChunk.kind === "silent" ? [startChunk] : splitInitialChunkForFastStart(startChunk);
  return [
    ...initialChunks,
    ...nextBlocks.flatMap<ReadAloudChunk>((block) => {
      const rawText = block.textContent ?? "";
      const text = rawText.trim();
      const blockStartOffset = Math.max(0, rawText.search(/\S/));
      if (block.tagName.toLowerCase() === "pre") {
        const chunk = createSilentCodeChunk(block);
        return chunk ? [chunk] : [];
      }
      const normalized = normalizeSpeechTextWithAlignment(text);
      const atomicSpans = readAloudChunkAtomicSpans(block, blockStartOffset, text.length);
      return text.length > 0 && normalized.speechText.length > 0
        ? [
            {
              id: `read-aloud-chunk-${nextReadAloudChunkId++}`,
              kind: "speech" as const,
              block,
              text,
              speechText: normalized.speechText,
              speechTokenAlignments: normalized.alignments,
              ...(atomicSpans.length > 0 ? { atomicSpans } : {}),
              blockStartOffset,
            },
          ]
        : [];
    }),
  ].filter(
    (chunk): chunk is ReadAloudChunk => chunk.kind === "silent" || wordCount(chunk.text) > 0,
  );
}

export const ThreadReadAloudProvider = memo(function ThreadReadAloudProvider({
  environmentId,
  threadKey,
  children,
}: {
  environmentId: EnvironmentId;
  threadKey: string;
  children: ReactNode;
}) {
  const audioRef = useRef<AudioPlaybackHandle | null>(null);
  const chunksRef = useRef<ReadAloudChunk[]>([]);
  const currentIndexRef = useRef(0);
  const activeAudioChunkIdRef = useRef<string | null>(null);
  const preparedAudioRef = useRef(new Map<string, Promise<PreparedAudioChunk>>());
  const preparedAudioByChunkRef = useRef(new Map<string, PreparedAudioChunk>());
  const rawCacheKeysRef = useRef(new Map<string, string>());
  const highlightGroupsRef = useRef(new Map<string, HighlightGroup[]>());
  const holdTimerRef = useRef<number | null>(null);
  const holdRemainingMsRef = useRef(0);
  const holdStartedAtRef = useRef(0);
  const holdUntilMsRef = useRef(0);
  const silentHoldActiveRef = useRef(false);
  const holdPausedRef = useRef(false);
  const activeHighlightRef = useRef<ActiveHighlightState | null>(null);
  const pendingResumeRef = useRef<{
    readonly generation: number;
    readonly chunkIndex: number;
    readonly progress: number;
    readonly sentenceIndex: number;
    readonly wasPlaying: boolean;
  } | null>(null);
  const previousTargetWpmRef = useRef(DEFAULT_TARGET_WPM);
  const generationRef = useRef(0);
  const startupTimingTraceRef = useRef<ReadAloudTimingTrace | null>(null);
  const viewportRefreshFrameRef = useRef<number | null>(null);
  const viewportRefreshUntilRef = useRef(0);
  const readAloudSettings = useSettings((settings) => ({
    highlightVariant: settings.readAloudHighlightStyle,
    indicatorType: settings.readAloudIndicatorType,
    targetWpm: settings.readAloudTargetWpm,
    voice: settings.readAloudVoice,
  }));
  const { updateSettings } = useUpdateSettings();
  const [snapshot, setSnapshot] = useState<AudioPlaybackSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<ReadAloudMode>("idle");
  const [silentLabel, setSilentLabel] = useState<string | null>(null);
  const [silentRemainingMs, setSilentRemainingMs] = useState<number | null>(null);
  const [activeCodeFocusKey, setActiveCodeFocusKey] = useState<string | null>(null);
  const targetWpm = readAloudSettings.targetWpm;
  const voice = readAloudSettings.voice;
  const indicatorType = readAloudSettings.indicatorType;
  const highlightVariant = readAloudSettings.highlightVariant;

  useLayoutEffect(() => {
    if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = HIGHLIGHT_STYLE_ID;
    style.textContent = `
::highlight(${HIGHLIGHT_NAME}) {
  background: var(--t3-read-aloud-sentence-bg, color-mix(in srgb, var(--primary) 5%, transparent));
  color: inherit;
  text-decoration-line: underline;
  text-decoration-color: var(--t3-read-aloud-sentence-underline, color-mix(in srgb, var(--primary) 26%, transparent));
  text-decoration-thickness: 1px;
  text-underline-offset: 0.22em;
}

::highlight(${WORD_HIGHLIGHT_NAME}) {
  background: var(--t3-read-aloud-word-bg, color-mix(in srgb, var(--primary) 9%, transparent));
  color: var(--t3-read-aloud-word-color, var(--foreground));
  text-decoration-line: underline;
  text-decoration-color: var(--t3-read-aloud-word-underline, color-mix(in srgb, var(--primary) 62%, transparent));
  text-decoration-thickness: 2px;
  text-underline-offset: 0.2em;
}

[${WORD_HIGHLIGHT_OVERLAY_HOST_ATTRIBUTE}="true"] {
  position: relative;
}

#${WORD_HIGHLIGHT_OVERLAY_ID} {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 2;
  pointer-events: none;
  border: var(--t3-read-aloud-overlay-border, 1px solid color-mix(in srgb, var(--primary) 18%, transparent));
  border-radius: var(--t3-read-aloud-overlay-radius, 4px);
  background: var(--t3-read-aloud-overlay-bg, color-mix(in srgb, var(--primary) 12%, transparent));
  box-shadow: var(--t3-read-aloud-overlay-shadow, inset 0 -1px 0 color-mix(in srgb, var(--primary) 56%, transparent));
  box-sizing: border-box;
  opacity: 0;
  transform-origin: left top;
  transition:
    transform 70ms ease-out,
    width 70ms ease-out,
    height 70ms ease-out,
    opacity 40ms linear;
}

#${WORD_HIGHLIGHT_OVERLAY_ID}[data-visible="true"] {
  opacity: 1;
}

#${WORD_HIGHLIGHT_OVERLAY_ID}[data-variant="left-marker"]::before {
  content: "";
  position: absolute;
  left: -0.22rem;
  bottom: 0.18rem;
  width: 0.2rem;
  height: 0.2rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--primary) 78%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  #${WORD_HIGHLIGHT_OVERLAY_ID} {
    transition: opacity 40ms linear;
  }
}

@keyframes t3-read-aloud-loading-strip {
  0% {
    transform: translateX(-62%) scaleX(0.28);
  }
  100% {
    transform: translateX(262%) scaleX(0.28);
  }
}

.animate-read-aloud-loading-strip {
  animation: t3-read-aloud-loading-strip 880ms cubic-bezier(0.22, 1, 0.36, 1) infinite;
}
`;
    document.head.append(style);
  }, []);

  useLayoutEffect(() => {
    applyReadAloudHighlightVariant(highlightVariant);
  }, [highlightVariant]);

  const stop = useCallback(() => {
    generationRef.current += 1;
    audioRef.current?.dispose();
    audioRef.current = null;
    preparedAudioRef.current = new Map();
    preparedAudioByChunkRef.current = new Map();
    rawCacheKeysRef.current = new Map();
    highlightGroupsRef.current = new Map();
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdRemainingMsRef.current = 0;
    holdStartedAtRef.current = 0;
    holdUntilMsRef.current = 0;
    silentHoldActiveRef.current = false;
    holdPausedRef.current = false;
    setSilentLabel(null);
    setSilentRemainingMs(null);
    activeHighlightRef.current = null;
    activeAudioChunkIdRef.current = null;
    startupTimingTraceRef.current = null;
    chunksRef.current = [];
    currentIndexRef.current = 0;
    commitReadAloudHighlightTarget({
      target: { kind: "clear" },
      chunks: chunksRef.current,
      currentChunkIndex: currentIndexRef.current,
      previousTarget: null,
      setActiveCodeFocusKey,
      clearPolicy: "clear",
    });
    setActive(false);
    setMode("idle");
    setSnapshot(null);
  }, []);

  const getHighlightGroups = useCallback((chunk: ReadAloudChunk): HighlightGroup[] => {
    const cached = highlightGroupsRef.current.get(chunk.id);
    if (cached) return cached;
    const groups = buildReadAloudHighlightGroups(chunk.text, readAloudSegmentationOptions(chunk));
    highlightGroupsRef.current.set(chunk.id, groups);
    return groups;
  }, []);

  const refreshCurrentHighlight = useCallback(() => {
    const currentHighlight = activeHighlightRef.current;
    if (!currentHighlight) return;
    const chunk = chunksRef.current[currentIndexRef.current];
    if (!chunk || chunk.id !== currentHighlight.chunkId) return;
    const groups = chunk.kind === "speech" ? getHighlightGroups(chunk) : [];
    const target =
      chunk.kind === "silent"
        ? ({
            kind: "silent-code",
            chunkId: chunk.id,
            codeFocusKey: chunk.codeFocusKey ?? null,
          } satisfies ReadAloudSilentCodeHighlightTarget)
        : buildSpeechHighlightTarget({
            chunk,
            sentenceIndex: currentHighlight.sentenceIndex,
            groupIndex: currentHighlight.groupIndex,
            wordIndex: currentHighlight.wordIndex,
            groups,
          });
    if (!target) return;
    commitReadAloudHighlightTarget({
      target,
      chunks: chunksRef.current,
      currentChunkIndex: currentIndexRef.current,
      previousTarget: currentHighlight,
      setActiveCodeFocusKey,
      groups,
      clearPolicy: "hold-previous",
      instantOverlay: true,
    });
  }, [getHighlightGroups, setActiveCodeFocusKey]);

  const loadAndPlayChunk = useCallback(
    async (index: number, generation = generationRef.current) => {
      const activeChunk = chunksRef.current[currentIndexRef.current];
      if (
        silentHoldActiveRef.current &&
        activeChunk?.kind === "silent" &&
        index !== currentIndexRef.current &&
        holdUntilMsRef.current > performance.now()
      ) {
        return;
      }
      const chunk = chunksRef.current[index];
      if (!chunk) {
        stop();
        return;
      }
      if (holdTimerRef.current) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
      }
      const api = readEnvironmentApi(environmentId);
      if (!api?.readAloud) throw new Error("Local AI Tools failed to start");
      const readAloudApi = api.readAloud;
      const timingTrace = index === 0 ? startupTimingTraceRef.current : null;
      const prepareChunk = (chunkIndex: number, trace: ReadAloudTimingTrace | null) => {
        const queuedChunk = chunksRef.current[chunkIndex];
        if (!queuedChunk || queuedChunk.kind !== "speech") return null;
        const preparedKey = `${generation}:${chunkIndex}:${voice}:${targetWpm}`;
        const existing = preparedAudioRef.current.get(preparedKey);
        if (existing) return existing;
        const promise = (async (): Promise<PreparedAudioChunk> => {
          markReadAloudTiming(trace, `chunk ${chunkIndex} synthesize request started`);
          const rawCacheKey = rawCacheKeysRef.current.get(queuedChunk.id);
          const result = await readAloudApi.synthesize({
            chunkId: queuedChunk.id,
            text: queuedChunk.speechText,
            voice,
            targetWpm,
            rawCacheKey,
          });
          markReadAloudTiming(trace, `chunk ${chunkIndex} synthesize response received`);
          if (generationRef.current !== generation)
            throw new Error("Read-aloud request superseded");
          rawCacheKeysRef.current.set(queuedChunk.id, result.rawCacheKey);
          const prepared = {
            audioUrl: result.audioDataUrl,
            timings: result.timings,
            rawCacheKey: result.rawCacheKey,
            renderedWpm: result.renderedWpm,
            tempoFactor: result.tempoFactor,
            wordCount: wordCount(queuedChunk.text),
          };
          preparedAudioByChunkRef.current.set(queuedChunk.id, prepared);
          return prepared;
        })();
        preparedAudioRef.current.set(preparedKey, promise);
        return promise;
      };
      if (chunk.kind === "silent") {
        activeAudioChunkIdRef.current = null;
        audioRef.current?.stop();
        const liveBlock = resolveLiveCodeBlockForChunk(chunk);
        const liveChunk =
          liveBlock === chunk.block
            ? chunk
            : {
                ...chunk,
                block: liveBlock,
                blockStartOffset: Math.max(
                  0,
                  (liveBlock.textContent ?? "").indexOf(chunk.text.trim()),
                ),
              };
        chunksRef.current[index] = liveChunk;
        const holdMs = chunk.holdMs ?? 1_500;
        currentIndexRef.current = index;
        holdPausedRef.current = false;
        holdRemainingMsRef.current = holdMs;
        holdStartedAtRef.current = performance.now();
        holdUntilMsRef.current = holdStartedAtRef.current + holdMs;
        silentHoldActiveRef.current = true;
        const nextHighlight = {
          chunkId: liveChunk.id,
          sentenceIndex: 0,
          groupIndex: 0,
          wordIndex: 0,
          updatedAt: performance.now(),
        };
        const commit = commitReadAloudHighlightTarget({
          target: {
            kind: "silent-code",
            chunkId: liveChunk.id,
            codeFocusKey: liveChunk.codeFocusKey ?? null,
          },
          chunks: chunksRef.current,
          currentChunkIndex: index,
          previousTarget: activeHighlightRef.current,
          setActiveCodeFocusKey,
          clearPolicy: "clear",
        });
        activeHighlightRef.current = nextHighlight;
        scrollReadAloudRangeIntoView({
          range: commit.sentenceRange,
          block: liveChunk.block,
          reason: "silent",
        });
        setMode("showing-code");
        setSilentLabel(liveChunk.silentLabel ?? null);
        setSilentRemainingMs(holdRemainingMsRef.current);
        setSnapshot((current) =>
          current
            ? { ...current, status: "playing", currentTimeSeconds: 0, durationSeconds: null }
            : {
                status: "playing",
                durationSeconds: null,
                currentTimeSeconds: 0,
                playbackRate: 1,
                generatedWpm: null,
                errorMessage: null,
              },
        );
        void prepareChunk(index + 1, null)?.catch(() => undefined);
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          if (generationRef.current !== generation) return;
          holdRemainingMsRef.current = 0;
          holdUntilMsRef.current = 0;
          silentHoldActiveRef.current = false;
          setSilentRemainingMs(null);
          setSilentLabel(null);
          void loadAndPlayChunk(index + 1, generation);
        }, holdMs);
        return;
      }
      setMode("loading");
      activeAudioChunkIdRef.current = null;
      setSilentLabel(null);
      setSilentRemainingMs(null);
      currentIndexRef.current = index;
      const groups = getHighlightGroups(chunk);
      const deferInitialHighlightUntilAudioReady = chunksRef.current[index - 1]?.kind === "silent";
      const initialHighlight = {
        chunkId: chunk.id,
        sentenceIndex: 0,
        groupIndex: 0,
        wordIndex: 0,
        updatedAt: performance.now(),
      };
      const initialTarget = buildSpeechHighlightTarget({
        chunk,
        sentenceIndex: 0,
        groupIndex: 0,
        wordIndex: 0,
        groups,
      });
      const commitInitialHighlight = () => {
        return initialTarget
          ? commitReadAloudHighlightTarget({
              target: initialTarget,
              chunks: chunksRef.current,
              currentChunkIndex: index,
              previousTarget: activeHighlightRef.current,
              setActiveCodeFocusKey,
              groups,
              clearPolicy: "clear",
            })
          : commitReadAloudHighlightTarget({
              target: { kind: "clear" },
              chunks: chunksRef.current,
              currentChunkIndex: index,
              previousTarget: activeHighlightRef.current,
              setActiveCodeFocusKey,
              clearPolicy: "clear",
            });
      };
      if (!deferInitialHighlightUntilAudioReady) {
        const initialCommit = commitInitialHighlight();
        if (initialCommit.committed) activeHighlightRef.current = initialHighlight;
        scrollReadAloudRangeIntoView({
          range: initialCommit.sentenceRange,
          block: chunk.block,
          reason: "speech",
        });
      }
      markReadAloudTiming(timingTrace, `chunk ${index} highlight initialized`);
      setSnapshot((current) => current ?? audioRef.current?.snapshot() ?? null);
      const preparedPromise = prepareChunk(index, timingTrace);
      if (chunksRef.current[index + 1]) {
        void prepareChunk(index + 1, null)?.catch(() => undefined);
      }
      if (!preparedPromise) throw new Error("No readable text at this position");
      const prepared = await preparedPromise;
      if (generationRef.current !== generation) return;
      markReadAloudTiming(timingTrace, `chunk ${index} prepared audio ready`);
      const audio = audioRef.current ?? createAudioPlaybackHandle();
      audioRef.current = audio;
      markReadAloudTiming(timingTrace, `chunk ${index} audio metadata load started`);
      const loaded = await audio.load({
        audioUrl: prepared.audioUrl,
      });
      if (generationRef.current !== generation) return;
      activeAudioChunkIdRef.current = chunk.id;
      markReadAloudTiming(timingTrace, `chunk ${index} audio metadata loaded`);
      if (deferInitialHighlightUntilAudioReady) {
        const initialCommit = commitInitialHighlight();
        if (initialCommit.committed) activeHighlightRef.current = initialHighlight;
        scrollReadAloudRangeIntoView({
          range: initialCommit.sentenceRange,
          block: chunk.block,
          reason: "speech",
        });
      }
      const pendingResume = pendingResumeRef.current;
      if (
        pendingResume &&
        pendingResume.generation === generation &&
        pendingResume.chunkIndex === index &&
        loaded.durationSeconds
      ) {
        const mappedWordIndex = wordIndexForTime(
          chunk.text,
          pendingResume.progress * loaded.durationSeconds,
          loaded.durationSeconds,
          readAloudSegmentationOptions(chunk),
        );
        const mappedSentence = sentenceIndexForWordIndex(
          chunk.text,
          mappedWordIndex,
          readAloudSegmentationOptions(chunk),
        );
        const shiftedWordIndex =
          mappedSentence === pendingResume.sentenceIndex
            ? Math.max(0, mappedWordIndex - 1)
            : mappedWordIndex;
        const totalWords = Math.max(
          1,
          wordSpans(chunk.text, readAloudSegmentationOptions(chunk)).length,
        );
        const seekSeconds = (shiftedWordIndex / totalWords) * loaded.durationSeconds;
        const groups = getHighlightGroups(chunk);
        const groupIndex = highlightGroupIndexForWordIndex(
          chunk.text,
          shiftedWordIndex,
          readAloudSegmentationOptions(chunk),
        );
        const group = groups[groupIndex];
        const sentenceIndex =
          group?.sentenceIndex ??
          sentenceIndexForWordIndex(
            chunk.text,
            shiftedWordIndex,
            readAloudSegmentationOptions(chunk),
          );
        const nextHighlight = {
          chunkId: chunk.id,
          sentenceIndex,
          groupIndex,
          wordIndex: shiftedWordIndex,
          updatedAt: performance.now(),
        };
        const target = buildSpeechHighlightTarget({
          chunk,
          sentenceIndex,
          groupIndex,
          wordIndex: shiftedWordIndex,
          groups,
        });
        const commit = target
          ? commitReadAloudHighlightTarget({
              target,
              chunks: chunksRef.current,
              currentChunkIndex: index,
              previousTarget: activeHighlightRef.current,
              setActiveCodeFocusKey,
              groups,
              clearPolicy: "hold-previous",
            })
          : { committed: false, sentenceRange: null };
        if (commit.committed) activeHighlightRef.current = nextHighlight;
        scrollReadAloudRangeIntoView({
          range: commit.sentenceRange,
          block: chunk.block,
          reason: "speech",
        });
        setSnapshot(audio.seek(seekSeconds));
        pendingResumeRef.current = null;
      } else {
        setSnapshot(loaded);
      }
      markReadAloudTiming(timingTrace, `chunk ${index} audio play requested`);
      if (!pendingResume || pendingResume.wasPlaying) {
        setSnapshot(await audio.play());
        setMode("playing");
      } else {
        setMode("paused");
      }
      markReadAloudTiming(timingTrace, `chunk ${index} audio play resolved`);
      if (index === 0) startupTimingTraceRef.current = null;
    },
    [environmentId, getHighlightGroups, stop, targetWpm, voice],
  );

  const startFrom = useCallback(
    async (chunks: ReadAloudChunk[], timingTrace: ReadAloudTimingTrace | null) => {
      stop();
      const generation = generationRef.current;
      startupTimingTraceRef.current = timingTrace;
      markReadAloudTiming(timingTrace, "read-aloud state reset");
      setError(null);
      setActive(true);
      setMode("loading");
      chunksRef.current = chunks;
      audioRef.current = createAudioPlaybackHandle();
      const audio = audioRef.current;
      const unsubscribeEnded = audio.on("ended", () => {
        const currentChunk = chunksRef.current[currentIndexRef.current];
        if (!currentChunk || currentChunk.kind !== "speech") return;
        void loadAndPlayChunk(currentIndexRef.current + 1, generation).catch((cause) => {
          if (generationRef.current !== generation || isReadAloudSuperseded(cause)) return;
          setError(cause instanceof Error ? cause.message : "Local AI Tools failed to start");
          stop();
        });
      });
      const unsubscribeError = audio.on("error", () => {
        setError(audio.snapshot().errorMessage ?? "Audio playback failed");
        setMode("error");
        stop();
      });
      const unsubscribeLoaded = audio.on("loaded", () => setSnapshot(audio.snapshot()));
      void loadAndPlayChunk(0, generation).catch((cause) => {
        if (generationRef.current !== generation || isReadAloudSuperseded(cause)) return;
        unsubscribeEnded();
        unsubscribeError();
        unsubscribeLoaded();
        setError(cause instanceof Error ? cause.message : "Local AI Tools failed to start");
        setMode("error");
        stop();
      });
    },
    [loadAndPlayChunk, stop],
  );

  const onMarkdownContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLElement>, root: HTMLElement | null) => {
      if (!root) return;
      const startChunk = resolveStartChunk(event, root);
      if (!startChunk) return;
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      const selected = await api?.contextMenu.show(READ_ALOUD_CONTEXT_MENU_ITEMS, {
        x: event.clientX,
        y: event.clientY,
      });
      if (selected === COPY_MENU_ID) {
        copyReadAloudContextText(
          selectedTextInReadAloudRoot(root) ?? wordTextForReadAloudMenuChunk(startChunk),
        );
        return;
      }
      if (selected === COPY_SENTENCE_MENU_ID) {
        copyReadAloudContextText(sentenceTextForReadAloudMenuChunk(startChunk));
        return;
      }
      if (selected === COPY_PARAGRAPH_MENU_ID) {
        copyReadAloudContextText(paragraphTextForReadAloudMenuChunk(startChunk));
        return;
      }
      if (selected !== READ_MENU_ID) return;
      const timingTrace = createReadAloudTimingTrace();
      startupTimingTraceRef.current = timingTrace;
      markReadAloudTiming(timingTrace, "context menu selection returned");
      const collectionRoot = root.closest<HTMLElement>(READ_ALOUD_THREAD_SCOPE_SELECTOR) ?? root;
      const chunks = collectChunks(collectionRoot, startChunk);
      markReadAloudTiming(timingTrace, `collected ${chunks.length} chunks`);
      if (chunks.length === 0) {
        setError("No readable text at this position");
        startupTimingTraceRef.current = null;
        return;
      }
      await startFrom(chunks, timingTrace);
    },
    [startFrom],
  );

  const skipCurrent = useCallback(() => {
    if (!(holdRemainingMsRef.current > 0 || holdTimerRef.current || holdPausedRef.current)) {
      return;
    }
    if (holdTimerRef.current) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    holdRemainingMsRef.current = 0;
    holdUntilMsRef.current = 0;
    silentHoldActiveRef.current = false;
    holdPausedRef.current = false;
    setSilentRemainingMs(null);
    setSilentLabel(null);
    const generation = generationRef.current;
    const index = currentIndexRef.current;
    void loadAndPlayChunk(index + 1, generation);
  }, [loadAndPlayChunk]);

  useEffect(() => stop, [stop, threadKey]);

  useEffect(() => {
    if (!active) return;
    const runViewportRefresh = () => {
      refreshCurrentHighlight();
      if (performance.now() >= viewportRefreshUntilRef.current) {
        viewportRefreshFrameRef.current = null;
        return;
      }
      viewportRefreshFrameRef.current = requestAnimationFrame(runViewportRefresh);
    };
    const scheduleViewportRefresh = () => {
      viewportRefreshUntilRef.current = performance.now() + 450;
      if (viewportRefreshFrameRef.current !== null) return;
      viewportRefreshFrameRef.current = requestAnimationFrame(runViewportRefresh);
    };
    const onViewportChange = () => {
      refreshCurrentHighlight();
      scheduleViewportRefresh();
    };
    window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChange);
    return () => {
      window.removeEventListener("scroll", onViewportChange, { capture: true });
      window.removeEventListener("resize", onViewportChange);
      if (viewportRefreshFrameRef.current !== null) {
        cancelAnimationFrame(viewportRefreshFrameRef.current);
        viewportRefreshFrameRef.current = null;
      }
      viewportRefreshUntilRef.current = 0;
    };
  }, [active, refreshCurrentHighlight]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key === "Enter") {
        if (!(holdRemainingMsRef.current > 0 || holdTimerRef.current || holdPausedRef.current)) {
          return;
        }
        event.preventDefault();
        skipCurrent();
        return;
      }
      if (event.key !== " " && event.code !== "Space") return;
      event.preventDefault();
      if (holdRemainingMsRef.current > 0 || holdTimerRef.current) {
        if (holdTimerRef.current) {
          window.clearTimeout(holdTimerRef.current);
          holdTimerRef.current = null;
          holdRemainingMsRef.current = Math.max(
            0,
            holdRemainingMsRef.current - (performance.now() - holdStartedAtRef.current),
          );
          holdPausedRef.current = true;
          setMode("code-paused");
          setSilentRemainingMs(holdRemainingMsRef.current);
          setSnapshot((current) => (current ? { ...current, status: "paused" } : current));
        } else if (holdPausedRef.current) {
          holdPausedRef.current = false;
          holdStartedAtRef.current = performance.now();
          setMode("showing-code");
          setSnapshot((current) => (current ? { ...current, status: "playing" } : current));
          const generation = generationRef.current;
          const index = currentIndexRef.current;
          holdTimerRef.current = window.setTimeout(() => {
            holdTimerRef.current = null;
            if (generationRef.current !== generation) return;
            holdRemainingMsRef.current = 0;
            setSilentRemainingMs(null);
            setSilentLabel(null);
            void loadAndPlayChunk(index + 1, generation);
          }, holdRemainingMsRef.current);
        }
        return;
      }
      const audio = audioRef.current;
      if (!audio) return;
      const current = audio.snapshot();
      if (current.status === "playing") {
        setSnapshot(audio.pause());
        setMode("paused");
      } else if (current.status === "paused" || current.status === "ready") {
        void audio.play().then((next) => {
          setSnapshot(next);
          setMode("playing");
        });
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [active, loadAndPlayChunk, skipCurrent]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      const audio = audioRef.current;
      const chunk = chunksRef.current[currentIndexRef.current] ?? null;
      if (!audio || !chunk) return;
      if (chunk.kind === "silent") return;
      if (activeAudioChunkIdRef.current !== chunk.id) return;
      const nextSnapshot = audio.snapshot();
      if (nextSnapshot.status !== "playing") return;
      setSnapshot(nextSnapshot);
      const mediaDuration = nextSnapshot.durationSeconds ?? 0;
      const groups = getHighlightGroups(chunk);
      const prepared = preparedAudioByChunkRef.current.get(chunk.id);
      const proportionalWordIndex = highlightGroupForTime(
        chunk.text,
        nextSnapshot.currentTimeSeconds,
        mediaDuration,
        readAloudSegmentationOptions(chunk),
      ).wordIndex;
      const wordIndex =
        prepared && prepared.timings.length > 0
          ? (displayWordIndexForReadAloudTimings({
              displayText: chunk.text,
              timings: prepared.timings,
              speechTokenAlignments: chunk.speechTokenAlignments,
              currentTime: nextSnapshot.currentTimeSeconds,
              ...(chunk.atomicSpans ? { atomicSpans: chunk.atomicSpans } : {}),
            }) ?? proportionalWordIndex)
          : proportionalWordIndex;
      const groupIndex = highlightGroupIndexForWordIndex(
        chunk.text,
        wordIndex,
        readAloudSegmentationOptions(chunk),
      );
      const group = groups[groupIndex];
      const nextSentenceIndex =
        group?.sentenceIndex ??
        sentenceIndexForWordIndex(chunk.text, wordIndex, readAloudSegmentationOptions(chunk));
      const currentHighlight = activeHighlightRef.current;
      if (
        !currentHighlight ||
        currentHighlight.chunkId !== chunk.id ||
        currentHighlight.sentenceIndex !== nextSentenceIndex ||
        currentHighlight.groupIndex !== groupIndex ||
        currentHighlight.wordIndex !== wordIndex
      ) {
        const nextHighlight = {
          chunkId: chunk.id,
          sentenceIndex: nextSentenceIndex,
          groupIndex,
          wordIndex,
          updatedAt: performance.now(),
        };
        const shouldScroll =
          !currentHighlight ||
          currentHighlight.chunkId !== chunk.id ||
          currentHighlight.sentenceIndex !== nextSentenceIndex;
        const target = buildSpeechHighlightTarget({
          chunk,
          sentenceIndex: nextSentenceIndex,
          groupIndex,
          wordIndex,
          groups,
        });
        if (!target) return;
        const commit = commitReadAloudHighlightTarget({
          target,
          chunks: chunksRef.current,
          currentChunkIndex: currentIndexRef.current,
          previousTarget: currentHighlight,
          setActiveCodeFocusKey,
          groups,
          clearPolicy: "hold-previous",
        });
        if (commit.committed) {
          activeHighlightRef.current = nextHighlight;
          if (shouldScroll) {
            scrollReadAloudRangeIntoView({
              range: commit.sentenceRange,
              block: chunk.block,
              reason: "speech",
            });
          }
        }
      }
    }, HIGHLIGHT_TICK_MS);
    return () => window.clearInterval(timer);
  }, [active, getHighlightGroups]);

  useEffect(() => {
    const previous = previousTargetWpmRef.current;
    previousTargetWpmRef.current = targetWpm;
    if (!active || previous === targetWpm) return;
    const audio = audioRef.current;
    const chunk = chunksRef.current[currentIndexRef.current];
    if (!audio || !chunk || chunk.kind !== "speech") return;
    const current = audio.snapshot();
    if (!current.durationSeconds || current.durationSeconds <= 0) return;
    const prepared = preparedAudioByChunkRef.current.get(chunk.id);
    const currentWordIndex =
      prepared && prepared.timings.length > 0
        ? (displayWordIndexForReadAloudTimings({
            displayText: chunk.text,
            timings: prepared.timings,
            speechTokenAlignments: chunk.speechTokenAlignments,
            currentTime: current.currentTimeSeconds,
            ...(chunk.atomicSpans ? { atomicSpans: chunk.atomicSpans } : {}),
          }) ??
          wordIndexForTime(
            chunk.text,
            current.currentTimeSeconds,
            current.durationSeconds,
            readAloudSegmentationOptions(chunk),
          ))
        : wordIndexForTime(
            chunk.text,
            current.currentTimeSeconds,
            current.durationSeconds,
            readAloudSegmentationOptions(chunk),
          );
    pendingResumeRef.current = {
      generation: generationRef.current,
      chunkIndex: currentIndexRef.current,
      progress: Math.min(1, Math.max(0, current.currentTimeSeconds / current.durationSeconds)),
      sentenceIndex: sentenceIndexForWordIndex(
        chunk.text,
        currentWordIndex,
        readAloudSegmentationOptions(chunk),
      ),
      wasPlaying: current.status === "playing",
    };
    if (current.status === "playing") audio.pause();
    void loadAndPlayChunk(currentIndexRef.current, generationRef.current).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Audio tempo render failed");
      pendingResumeRef.current = null;
    });
  }, [active, loadAndPlayChunk, targetWpm]);

  const canResume =
    mode === "paused" ||
    mode === "code-paused" ||
    snapshot?.status === "paused" ||
    snapshot?.status === "ready";
  const isPlaying = mode === "playing" && snapshot?.status === "playing";
  const isActiveProgress = mode === "playing" || mode === "showing-code";
  const isLoading = active && mode === "loading";
  const statusLabel = readAloudStatusLabel(mode);
  const setClampedTargetWpm = useCallback(
    (wpm: number) => {
      if (Number.isFinite(wpm)) {
        const nextWpm = Math.min(MAX_WPM, Math.max(MIN_WPM, wpm));
        updateSettings({ readAloudTargetWpm: nextWpm });
      }
    },
    [updateSettings],
  );
  const setGlobalVoice = useCallback(
    (nextVoice: string) => {
      if (VOICES.some((voiceOption) => voiceOption === nextVoice)) {
        updateSettings({ readAloudVoice: nextVoice as ReadAloudVoice });
      }
    },
    [updateSettings],
  );
  const setGlobalIndicatorType = useCallback(
    (nextIndicatorType: ReadAloudIndicatorType) => {
      updateSettings({ readAloudIndicatorType: nextIndicatorType });
    },
    [updateSettings],
  );
  const setGlobalHighlightVariant = useCallback(
    (nextHighlightVariant: ReadAloudHighlightVariant) => {
      updateSettings({ readAloudHighlightStyle: nextHighlightVariant });
    },
    [updateSettings],
  );
  const togglePlayback = useCallback(() => {
    if (holdRemainingMsRef.current > 0 || holdTimerRef.current) {
      if (holdTimerRef.current) {
        window.clearTimeout(holdTimerRef.current);
        holdTimerRef.current = null;
        holdRemainingMsRef.current = Math.max(
          0,
          holdRemainingMsRef.current - (performance.now() - holdStartedAtRef.current),
        );
        holdUntilMsRef.current = 0;
        silentHoldActiveRef.current = true;
        holdPausedRef.current = true;
        setMode("code-paused");
        setSilentRemainingMs(holdRemainingMsRef.current);
        setSnapshot((current) => (current ? { ...current, status: "paused" } : current));
      } else if (holdPausedRef.current) {
        holdPausedRef.current = false;
        holdStartedAtRef.current = performance.now();
        holdUntilMsRef.current = holdStartedAtRef.current + holdRemainingMsRef.current;
        silentHoldActiveRef.current = true;
        setMode("showing-code");
        setSnapshot((current) => (current ? { ...current, status: "playing" } : current));
        const generation = generationRef.current;
        const index = currentIndexRef.current;
        holdTimerRef.current = window.setTimeout(() => {
          holdTimerRef.current = null;
          if (generationRef.current !== generation) return;
          holdRemainingMsRef.current = 0;
          holdUntilMsRef.current = 0;
          silentHoldActiveRef.current = false;
          setSilentRemainingMs(null);
          setSilentLabel(null);
          void loadAndPlayChunk(index + 1, generation);
        }, holdRemainingMsRef.current);
      }
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    const current = audio.snapshot();
    if (current.status === "playing") {
      setSnapshot(audio.pause());
      setMode("paused");
    } else if (current.status === "paused" || current.status === "ready") {
      void audio.play().then((next) => {
        setSnapshot(next);
        setMode("playing");
      });
    }
  }, [loadAndPlayChunk]);

  const value = useMemo<ThreadReadAloudContextValue>(
    () => ({
      active,
      activeCodeFocusKey,
      canResume,
      highlightVariant,
      isLoading,
      isPlaying,
      isActiveProgress,
      indicatorType,
      mode,
      onMarkdownContextMenu,
      setIndicatorType: setGlobalIndicatorType,
      setHighlightVariant: setGlobalHighlightVariant,
      setTargetWpm: setClampedTargetWpm,
      setVoice: setGlobalVoice,
      silentLabel,
      silentRemainingMs,
      snapshot,
      stop,
      statusLabel,
      skipCurrent,
      targetWpm,
      togglePlayback,
      voice,
    }),
    [
      active,
      activeCodeFocusKey,
      canResume,
      highlightVariant,
      indicatorType,
      isLoading,
      isPlaying,
      isActiveProgress,
      onMarkdownContextMenu,
      mode,
      setGlobalIndicatorType,
      setGlobalHighlightVariant,
      setGlobalVoice,
      setClampedTargetWpm,
      silentLabel,
      silentRemainingMs,
      snapshot,
      stop,
      statusLabel,
      skipCurrent,
      targetWpm,
      togglePlayback,
      voice,
    ],
  );

  return (
    <ThreadReadAloudContext value={value}>
      {children}
      {error ? (
        <div
          className={cn(
            "fixed right-4 bottom-16 z-40 rounded-md border border-destructive/40 bg-popover px-3 py-2 text-[11px] text-destructive shadow-lg/10",
          )}
        >
          {error}
        </div>
      ) : null}
    </ThreadReadAloudContext>
  );
});
