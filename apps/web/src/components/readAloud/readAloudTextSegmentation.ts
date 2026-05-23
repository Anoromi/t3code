import winkNLP from "wink-nlp";
import model from "wink-eng-lite-web-model";

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

export interface SentenceSpan extends TextSpan {}

export interface HighlightToken extends TextSpan {
  readonly text: string;
  readonly type: "word" | "number" | "technical";
  readonly pos: string | null;
  readonly stopWord: boolean;
  readonly sentenceIndex: number;
}

export interface HighlightGroup extends TextSpan {
  readonly tokenIndexes: readonly number[];
  readonly sentenceIndex: number;
}

export interface HighlightGroupOptions {
  readonly targetChars?: number;
  readonly maxChars?: number;
  readonly atomicSpans?: readonly TextSpan[];
}

export const DEFAULT_HIGHLIGHT_GROUP_TARGET_CHARS = 8;
export const DEFAULT_HIGHLIGHT_GROUP_MAX_CHARS = 22;

const nlp = winkNLP(model);
const its = nlp.its;

function trimSpan(text: string, span: TextSpan): SentenceSpan | null {
  const raw = text.slice(span.start, span.end);
  const leading = raw.match(/^\s*/)?.[0].length ?? 0;
  const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
  const start = span.start + leading;
  const end = span.end - trailing;
  return end > start ? { start, end } : null;
}

function offsetInSpans(offset: number, spans: readonly TextSpan[]): boolean {
  return spans.some((span) => offset >= span.start && offset < span.end);
}

function overlapsSpan(span: TextSpan, spans: readonly TextSpan[]): boolean {
  return spans.some((candidate) => span.start < candidate.end && span.end > candidate.start);
}

function normalizeProvidedSpans(text: string, spans: readonly TextSpan[] = []): TextSpan[] {
  return spans
    .map((span) => trimSpan(text, span))
    .filter((span): span is TextSpan => span !== null)
    .toSorted((left, right) => left.start - right.start)
    .reduce<TextSpan[]>((merged, span) => {
      const previous = merged.at(-1);
      if (!previous || span.start > previous.end) {
        merged.push({ start: span.start, end: span.end });
        return merged;
      }
      merged[merged.length - 1] = {
        start: previous.start,
        end: Math.max(previous.end, span.end),
      };
      return merged;
    }, []);
}

function mergeProtectedSpans(text: string, spans: readonly TextSpan[]): TextSpan[] {
  return normalizeProvidedSpans(text, [...protectedTechnicalSpans(text), ...spans]);
}

export function protectedTechnicalSpans(text: string): TextSpan[] {
  const pattern =
    /(?:https?:\/\/\S+|localhost:\d+|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|@?[\p{L}\p{N}][\p{L}\p{N}_-]*(?:[/:.][\p{L}\p{N}][\p{L}\p{N}_-]*)+|\d+(?:\.\d+){1,})/gu;
  return [...text.matchAll(pattern)]
    .map((match) => ({
      start: match.index ?? 0,
      end: (match.index ?? 0) + match[0].length,
    }))
    .toSorted((left, right) => left.start - right.start);
}

function fallbackSentenceSpans(text: string): SentenceSpan[] {
  const protectedSpans = protectedTechnicalSpans(text);
  const spans: SentenceSpan[] = [];
  let rawStart = 0;
  const pushSpan = (rawEnd: number) => {
    const span = trimSpan(text, { start: rawStart, end: rawEnd });
    if (span) spans.push(span);
    rawStart = rawEnd;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n") {
      pushSpan(index);
      rawStart = index + 1;
      continue;
    }
    if ((char === "." || char === "!" || char === "?") && !offsetInSpans(index, protectedSpans)) {
      let end = index + 1;
      while (end < text.length && (text[end] === "." || text[end] === "!" || text[end] === "?")) {
        end += 1;
      }
      pushSpan(end);
      index = end - 1;
    }
  }
  pushSpan(text.length);
  return spans.length > 0 ? spans : [{ start: 0, end: text.length }];
}

function splitSentenceSpanOnNewlines(text: string, span: TextSpan): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = span.start;
  for (let index = span.start; index < span.end; index += 1) {
    if (text[index] !== "\n") continue;
    const trimmed = trimSpan(text, { start, end: index });
    if (trimmed) spans.push(trimmed);
    start = index + 1;
  }
  const trimmed = trimSpan(text, { start, end: span.end });
  if (trimmed) spans.push(trimmed);
  return spans;
}

export function sentenceSpans(text: string): SentenceSpan[] {
  try {
    const protectedSpans = protectedTechnicalSpans(text);
    const doc = nlp.readDoc(text);
    const sentenceTexts = doc.sentences().out() as string[];
    const mapped: SentenceSpan[] = [];
    let cursor = 0;
    for (const sentenceText of sentenceTexts) {
      const start = text.indexOf(sentenceText, cursor);
      if (start < 0) return fallbackSentenceSpans(text);
      const end = start + sentenceText.length;
      cursor = end;
      if (protectedSpans.some((span) => start > span.start && start < span.end)) {
        return fallbackSentenceSpans(text);
      }
      for (const span of splitSentenceSpanOnNewlines(text, { start, end })) {
        mapped.push(span);
      }
    }
    if (mapped.length === 0) return fallbackSentenceSpans(text);
    const fallback = fallbackSentenceSpans(text);
    if (fallback.length > mapped.length) return fallback;
    return mapped;
  } catch {
    return fallbackSentenceSpans(text);
  }
}

function sentenceIndexForOffset(text: string, offset: number): number {
  const spans = sentenceSpans(text);
  const index = spans.findIndex((span) => offset >= span.start && offset < span.end);
  return index >= 0 ? index : 0;
}

function fallbackTokens(text: string, options: HighlightGroupOptions = {}): HighlightToken[] {
  const protectedSpans = mergeProtectedSpans(text, options.atomicSpans ?? []);
  const protectedTokens = protectedSpans.map((span) => ({
    ...span,
    text: text.slice(span.start, span.end),
    type: "technical" as const,
    pos: null,
    stopWord: false,
    sentenceIndex: sentenceIndexForOffset(text, span.start),
  }));
  const wordTokens = [...text.matchAll(/[\p{L}\p{N}](?:[\p{L}\p{N}'-]*[\p{L}\p{N}])?/gu)]
    .map((match): HighlightToken => {
      const start = match.index ?? 0;
      const tokenText = match[0];
      return {
        start,
        end: start + tokenText.length,
        text: tokenText,
        type: /^\d+$/u.test(tokenText) ? "number" : "word",
        pos: null,
        stopWord: tokenText.length < 3,
        sentenceIndex: sentenceIndexForOffset(text, start),
      };
    })
    .filter((span) => !overlapsSpan(span, protectedSpans));
  return [...protectedTokens, ...wordTokens].toSorted((left, right) => left.start - right.start);
}

function winkTokenType(tokenType: string): HighlightToken["type"] | null {
  if (tokenType === "word") return "word";
  if (tokenType === "number") return "number";
  return null;
}

export function tokenizeForReadAloudHighlight(
  text: string,
  options: HighlightGroupOptions = {},
): HighlightToken[] {
  try {
    const protectedSpans = mergeProtectedSpans(text, options.atomicSpans ?? []);
    const protectedTokens = protectedSpans.map((span) => ({
      ...span,
      text: text.slice(span.start, span.end),
      type: "technical" as const,
      pos: null,
      stopWord: false,
      sentenceIndex: sentenceIndexForOffset(text, span.start),
    }));
    const doc = nlp.readDoc(text);
    const tokens = doc.tokens();
    const tokenTexts = tokens.out() as string[];
    const tokenTypes = tokens.out(its.type) as string[];
    const tokenPos = tokens.out(its.pos) as string[];
    const tokenStopWords = tokens.out(its.stopWordFlag) as boolean[];
    const mappedTokens: HighlightToken[] = [];
    let cursor = 0;
    for (let index = 0; index < tokenTexts.length; index += 1) {
      const tokenText = tokenTexts[index] ?? "";
      const start = text.indexOf(tokenText, cursor);
      if (start < 0) return fallbackTokens(text, options);
      const end = start + tokenText.length;
      cursor = end;
      if (offsetInSpans(start, protectedSpans)) continue;
      const type = winkTokenType(tokenTypes[index] ?? "");
      if (!type) continue;
      mappedTokens.push({
        start,
        end,
        text: tokenText,
        type,
        pos: tokenPos[index] ?? null,
        stopWord: tokenStopWords[index] ?? false,
        sentenceIndex: sentenceIndexForOffset(text, start),
      });
    }
    return [...protectedTokens, ...mappedTokens].toSorted(
      (left, right) => left.start - right.start,
    );
  } catch {
    return fallbackTokens(text, options);
  }
}

export function wordSpans(text: string, options: HighlightGroupOptions = {}): TextSpan[] {
  return tokenizeForReadAloudHighlight(text, options).map(({ start, end }) => ({ start, end }));
}

function tokenLength(token: HighlightToken): number {
  return token.end - token.start;
}

function groupLength(text: string, tokens: readonly HighlightToken[]): number {
  if (tokens.length === 0) return 0;
  return text.slice(tokens[0]!.start, tokens.at(-1)!.end).length;
}

function hasHighlightGroupBoundaryBetween(
  text: string,
  left: HighlightToken,
  right: HighlightToken,
): boolean {
  return /[\n,;:!?]/u.test(text.slice(left.end, right.start));
}

function isFunctionLike(token: HighlightToken): boolean {
  if (
    token.pos === "VERB" ||
    token.pos === "NOUN" ||
    token.pos === "PROPN" ||
    token.pos === "ADJ" ||
    token.pos === "ADV"
  ) {
    return false;
  }
  return (
    token.stopWord ||
    token.pos === "ADP" ||
    token.pos === "DET" ||
    token.pos === "AUX" ||
    token.pos === "CCONJ" ||
    token.pos === "SCONJ" ||
    token.pos === "PART" ||
    token.pos === "PRON"
  );
}

function isLongAdverb(token: HighlightToken, targetChars: number): boolean {
  return token.pos === "ADV" && tokenLength(token) >= targetChars;
}

function makeGroup(
  tokens: readonly HighlightToken[],
  tokenIndexes: readonly number[],
): HighlightGroup {
  const first = tokens[0]!;
  const last = tokens.at(-1)!;
  return {
    start: first.start,
    end: last.end,
    sentenceIndex: first.sentenceIndex,
    tokenIndexes,
  };
}

export function buildReadAloudHighlightGroups(
  text: string,
  options: HighlightGroupOptions = {},
): HighlightGroup[] {
  const targetChars = options.targetChars ?? DEFAULT_HIGHLIGHT_GROUP_TARGET_CHARS;
  const maxChars = options.maxChars ?? DEFAULT_HIGHLIGHT_GROUP_MAX_CHARS;
  const tokens = tokenizeForReadAloudHighlight(text, options);
  const groups: HighlightGroup[] = [];
  let pendingTokens: HighlightToken[] = [];
  let pendingIndexes: number[] = [];
  const flush = () => {
    if (pendingTokens.length === 0) return;
    groups.push(makeGroup(pendingTokens, pendingIndexes));
    pendingTokens = [];
    pendingIndexes = [];
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1];
    const tokenIsSmall = tokenLength(token) < targetChars;
    const tokenIsFunctionLike = isFunctionLike(token);
    const tokenIsConnector = tokenIsSmall || tokenIsFunctionLike;
    const previous = pendingTokens.at(-1);

    if (pendingTokens.length > 0 && pendingTokens[0]!.sentenceIndex !== token.sentenceIndex) {
      flush();
    }
    if (previous && hasHighlightGroupBoundaryBetween(text, previous, token)) {
      flush();
    }

    if (token.type === "technical" || isLongAdverb(token, targetChars)) {
      flush();
      groups.push(makeGroup([token], [index]));
      continue;
    }

    if (pendingTokens.length === 0) {
      pendingTokens = [token];
      pendingIndexes = [index];
      if (
        !tokenIsConnector &&
        (!next ||
          next.sentenceIndex !== token.sentenceIndex ||
          next.type === "technical" ||
          (!isFunctionLike(next) && tokenLength(next) >= targetChars))
      ) {
        flush();
      }
      continue;
    }

    const candidateTokens = [...pendingTokens, token];
    const candidateLength = groupLength(text, candidateTokens);
    const pendingHasAnyContent = pendingTokens.some(
      (pendingToken) => !isFunctionLike(pendingToken),
    );
    const pendingHasOnlyFunctionWords = pendingTokens.every(isFunctionLike);
    const shouldReserveCurrentForNext =
      pendingTokens.length === 1 &&
      !isFunctionLike(pendingTokens[0]!) &&
      !isFunctionLike(token) &&
      Boolean(next) &&
      next?.sentenceIndex === token.sentenceIndex &&
      next.type !== "technical" &&
      !hasHighlightGroupBoundaryBetween(text, token, next) &&
      !isFunctionLike(next) &&
      tokenLength(token) <= 5 &&
      tokenLength(next) <= 6 &&
      groupLength(text, [token, next]) <= maxChars;
    const combinesTwoContent =
      pendingHasAnyContent &&
      !isFunctionLike(token) &&
      (candidateLength >= targetChars ||
        Boolean(next && next.sentenceIndex === token.sentenceIndex && isFunctionLike(next))) &&
      !(
        pendingTokens.length === 1 &&
        tokenLength(pendingTokens[0]!) <= 5 &&
        tokenLength(token) <= 5
      );
    const shouldEndFunctionPhrase =
      pendingHasOnlyFunctionWords && pendingTokens.length >= 2 && !isFunctionLike(token);
    if (
      candidateLength > maxChars ||
      combinesTwoContent ||
      shouldEndFunctionPhrase ||
      shouldReserveCurrentForNext
    ) {
      flush();
      pendingTokens = [token];
      pendingIndexes = [index];
    } else {
      pendingTokens = candidateTokens;
      pendingIndexes = [...pendingIndexes, index];
    }

    const currentLength = groupLength(text, pendingTokens);
    const nextCanJoin =
      next &&
      next.sentenceIndex === token.sentenceIndex &&
      next.type !== "technical" &&
      !hasHighlightGroupBoundaryBetween(text, token, next) &&
      currentLength + 1 + tokenLength(next) <= maxChars &&
      (isFunctionLike(next) || tokenLength(next) < targetChars);
    if (currentLength >= targetChars || !nextCanJoin) flush();
  }

  flush();
  return groups;
}

export function wordIndexForTime(
  text: string,
  currentTime: number,
  effectiveDuration: number,
  options: HighlightGroupOptions = {},
): number {
  const words = wordSpans(text, options);
  if (words.length === 0 || effectiveDuration <= 0) return 0;
  const progress = Math.min(1, Math.max(0, currentTime / effectiveDuration));
  return Math.min(words.length - 1, Math.floor(progress * words.length));
}

export function sentenceIndexForWordIndex(
  text: string,
  wordIndex: number,
  options: HighlightGroupOptions = {},
): number {
  const word = wordSpans(text, options)[wordIndex];
  if (!word) return 0;
  const spans = sentenceSpans(text);
  const containingIndex = spans.findIndex(
    (span) => word.start >= span.start && word.start < span.end,
  );
  return containingIndex >= 0 ? containingIndex : 0;
}

export function highlightGroupIndexForWordIndex(
  text: string,
  wordIndex: number,
  options: HighlightGroupOptions = {},
): number {
  const word = wordSpans(text, options)[wordIndex];
  if (!word) return 0;
  const groups = buildReadAloudHighlightGroups(text, options);
  const groupIndex = groups.findIndex(
    (group) => word.start >= group.start && word.start < group.end,
  );
  return groupIndex >= 0 ? groupIndex : 0;
}

export function highlightGroupForTime(
  text: string,
  currentTime: number,
  effectiveDuration: number,
  options: HighlightGroupOptions = {},
): {
  readonly groupIndex: number;
  readonly wordIndex: number;
} {
  const wordIndex = wordIndexForTime(text, currentTime, effectiveDuration, options);
  return {
    wordIndex,
    groupIndex: highlightGroupIndexForWordIndex(text, wordIndex, options),
  };
}
