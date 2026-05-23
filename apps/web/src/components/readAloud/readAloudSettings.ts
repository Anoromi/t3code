import {
  DEFAULT_READ_ALOUD_INDICATOR_TYPE,
  DEFAULT_READ_ALOUD_HIGHLIGHT_STYLE,
  DEFAULT_READ_ALOUD_TARGET_WPM,
  DEFAULT_READ_ALOUD_VOICE,
  type ReadAloudHighlightStyle,
  type ReadAloudIndicatorType,
  type ReadAloudVoice,
} from "@t3tools/contracts/settings";

export const MIN_READ_ALOUD_WPM = 120;
export const MAX_READ_ALOUD_WPM = 1000;
export const READ_ALOUD_WPM_OPTIONS = [
  120, 160, 200, 250, 300, 350, 400, 500, 650, 800, 1000,
] as const;

export const READ_ALOUD_VOICES = [
  "af_sarah",
  "af_bella",
  "af_nicole",
  "am_adam",
  "am_michael",
] as const satisfies readonly ReadAloudVoice[];

export const READ_ALOUD_INDICATOR_TYPES = [
  "dot",
  "rail",
  "icon",
] as const satisfies readonly ReadAloudIndicatorType[];

export const READ_ALOUD_HIGHLIGHT_STYLES = [
  "soft-wash",
  "underline-rail",
  "cursor-capsule",
  "left-marker",
  "muted-amber",
] as const satisfies readonly ReadAloudHighlightStyle[];

export const READ_ALOUD_INDICATOR_LABELS: Record<ReadAloudIndicatorType, string> = {
  dot: "Dot",
  rail: "Rail",
  icon: "Icon",
};

export const READ_ALOUD_HIGHLIGHT_LABELS: Record<ReadAloudHighlightStyle, string> = {
  "soft-wash": "Soft wash",
  "underline-rail": "Underline rail",
  "cursor-capsule": "Cursor capsule",
  "left-marker": "Left marker",
  "muted-amber": "Muted amber",
};

export function readAloudVoiceLabel(voice: string): string {
  return voice.replace(/^a[fm]_/, "");
}

export const READ_ALOUD_WPM_SELECT_ITEMS = READ_ALOUD_WPM_OPTIONS.map((wpm) => ({
  label: `${wpm} WPM`,
  value: String(wpm),
}));

export const READ_ALOUD_VOICE_SELECT_ITEMS = READ_ALOUD_VOICES.map((voice) => ({
  label: readAloudVoiceLabel(voice),
  value: voice,
}));

export const READ_ALOUD_INDICATOR_SELECT_ITEMS = READ_ALOUD_INDICATOR_TYPES.map((type) => ({
  label: READ_ALOUD_INDICATOR_LABELS[type],
  value: type,
}));

export const READ_ALOUD_HIGHLIGHT_SELECT_ITEMS = READ_ALOUD_HIGHLIGHT_STYLES.map((style) => ({
  label: READ_ALOUD_HIGHLIGHT_LABELS[style],
  value: style,
}));

export function normalizeReadAloudWpm(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_READ_ALOUD_TARGET_WPM;
  const rounded = Math.round(value / 10) * 10;
  return Math.min(MAX_READ_ALOUD_WPM, Math.max(MIN_READ_ALOUD_WPM, rounded));
}

export {
  DEFAULT_READ_ALOUD_HIGHLIGHT_STYLE,
  DEFAULT_READ_ALOUD_INDICATOR_TYPE,
  DEFAULT_READ_ALOUD_TARGET_WPM,
  DEFAULT_READ_ALOUD_VOICE,
};
