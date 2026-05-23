import { tokenizeForReadAloudHighlight } from "./readAloudTextSegmentation";

export interface SpeechTokenAlignment {
  readonly speechTokenIndex: number;
  readonly speechText: string;
  readonly displayTokenIndex: number;
  readonly displayStart: number;
  readonly displayEnd: number;
}

export interface NormalizedSpeechText {
  readonly speechText: string;
  readonly alignments: readonly SpeechTokenAlignment[];
}

const TECHNICAL_TOKEN_PATTERN =
  /(?:@?[\p{L}\p{N}][\p{L}\p{N}_-]*(?:[/:.][\p{L}\p{N}][\p{L}\p{N}_-]*)+|`[^`]+`)/gu;

function normalizeTechnicalToken(token: string): string {
  const unwrapped = token.replace(/^[`"'([{]+|[`"')\]}.,!?;]+$/g, "");
  if (!unwrapped) return "";
  if (unwrapped.includes("/")) {
    const parts = unwrapped.replace(/^@/, "").split("/").filter(Boolean);
    if (parts.length >= 2) {
      const first = parts[0] ?? "";
      const last = parts.at(-1) ?? "";
      return normalizeSimpleToken(`${first} ${last}`);
    }
  }
  return normalizeSimpleToken(unwrapped);
}

function normalizeSimpleToken(token: string): string {
  return token
    .replace(/^@/, "")
    .replace(/\.(?=[\p{L}\p{N}]+$)/gu, " dot ")
    .replace(/[-/:_@#~]+/g, " ")
    .replace(/[()[\]{}"'`]+/g, " ")
    .replace(/\.(?!\s|$)/g, " ")
    .toLowerCase();
}

function speechWords(text: string): string[] {
  return [...text.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}'-]*[\p{L}\p{N}])?/gu)].map(
    (match) => match[0],
  );
}

export function normalizeSpeechTextWithAlignment(input: string): NormalizedSpeechText {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    return { speechText: "", alignments: [] };
  }

  const tokens = tokenizeForReadAloudHighlight(trimmedInput);
  const speechTokens: string[] = [];
  const alignments: SpeechTokenAlignment[] = [];

  for (let displayTokenIndex = 0; displayTokenIndex < tokens.length; displayTokenIndex += 1) {
    const token = tokens[displayTokenIndex]!;
    const normalizedToken = normalizeTechnicalToken(token.text);
    for (const speechText of speechWords(normalizedToken)) {
      alignments.push({
        speechTokenIndex: speechTokens.length,
        speechText,
        displayTokenIndex,
        displayStart: token.start,
        displayEnd: token.end,
      });
      speechTokens.push(speechText);
    }
  }

  return {
    speechText: normalizeSpeechTextString(input),
    alignments,
  };
}

function normalizeSpeechTextString(input: string): string {
  return input
    .replace(TECHNICAL_TOKEN_PATTERN, (token) => normalizeTechnicalToken(token))
    .replace(/[()[\]{}"`]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export function normalizeSpeechText(input: string): string {
  return normalizeSpeechTextWithAlignment(input).speechText;
}
