import { describe, expect, it } from "vitest";

import {
  buildReadAloudHighlightGroups,
  highlightGroupForTime,
  sentenceSpans,
  tokenizeForReadAloudHighlight,
} from "./readAloudTextSegmentation";

function spanTexts(text: string, spans: readonly { start: number; end: number }[]): string[] {
  return spans.map((span) => text.slice(span.start, span.end));
}

function groupTexts(text: string): string[] {
  return spanTexts(text, buildReadAloudHighlightGroups(text));
}

function groupTextsWithAtomicSpans(
  text: string,
  atomicSpans: readonly { start: number; end: number }[],
): string[] {
  return spanTexts(text, buildReadAloudHighlightGroups(text, { atomicSpans }));
}

describe("sentenceSpans", () => {
  it("splits normal prose", () => {
    const text = "The repo is ready. The test passed.";

    expect(spanTexts(text, sentenceSpans(text))).toEqual([
      "The repo is ready.",
      "The test passed.",
    ]);
  });

  it("does not split technical dots", () => {
    const text = "Read AGENTS.md before changing apps/server/src/ws.ts. Next.";

    expect(spanTexts(text, sentenceSpans(text))).toEqual([
      "Read AGENTS.md before changing apps/server/src/ws.ts.",
      "Next.",
    ]);
  });

  it("keeps newlines as hard boundaries", () => {
    const text = "Wind moves through the pines,\nTelling secrets to the lake\nToo old to repeat.";

    expect(spanTexts(text, sentenceSpans(text))).toEqual([
      "Wind moves through the pines,",
      "Telling secrets to the lake",
      "Too old to repeat.",
    ]);
  });

  it("does not split semver", () => {
    const text = "Version 1.2.3 is installed. Continue.";

    expect(spanTexts(text, sentenceSpans(text))).toEqual([
      "Version 1.2.3 is installed.",
      "Continue.",
    ]);
  });
});

describe("tokenizeForReadAloudHighlight", () => {
  it("keeps technical tokens atomic", () => {
    const text = "Run make debug per AGENTS.md and apps/server/src/ws.ts.";

    expect(tokenizeForReadAloudHighlight(text).map((token) => token.text)).toEqual([
      "Run",
      "make",
      "debug",
      "per",
      "AGENTS.md",
      "and",
      "apps/server/src/ws.ts",
    ]);
  });

  it("keeps uppercase underscore identifiers atomic", () => {
    const text = "Read T3CODE_STATE_DIR, then continue.";

    expect(tokenizeForReadAloudHighlight(text).map((token) => token.text)).toContain(
      "T3CODE_STATE_DIR",
    );
  });

  it("keeps caller-provided atomic spans as one token", () => {
    const text = "Run bun run dev:web now.";
    const start = text.indexOf("bun");
    const end = text.indexOf(" now");

    expect(
      tokenizeForReadAloudHighlight(text, { atomicSpans: [{ start, end }] }).map(
        (token) => token.text,
      ),
    ).toEqual(["Run", "bun run dev:web", "now"]);
  });
});

describe("buildReadAloudHighlightGroups", () => {
  it("attaches function words forward", () => {
    expect(groupTexts("The repo is ready.")).toEqual(["The repo", "is ready"]);
  });

  it("attaches articles", () => {
    expect(groupTexts("A quick sanity check of the repo.")).toEqual([
      "A quick",
      "sanity",
      "check of",
      "the repo",
    ]);
  });

  it("groups auxiliaries and pronouns", () => {
    expect(groupTexts("I can run make debug.")).toEqual(["I can", "run", "make debug"]);
  });

  it("avoids awkward long adverb grouping", () => {
    expect(groupTexts("Technically we should wait.")).toEqual(["Technically", "we should", "wait"]);
  });

  it("does not cross sentence boundaries", () => {
    expect(groupTexts("The repo is ready. A test passed.")).toEqual([
      "The repo",
      "is ready",
      "A test",
      "passed",
    ]);
  });

  it("does not cross comma boundaries", () => {
    expect(groupTexts("Read T3CODE_STATE_DIR, so the server continues.")).toEqual([
      "Read",
      "T3CODE_STATE_DIR",
      "so the",
      "server",
      "continues",
    ]);
  });

  it("does not group caller-provided atomic spans with surrounding text", () => {
    const text = "Use bun run dev:web and continue.";
    const start = text.indexOf("bun");
    const end = text.indexOf(" and");

    expect(groupTextsWithAtomicSpans(text, [{ start, end }])).toEqual([
      "Use",
      "bun run dev:web",
      "and continue",
    ]);
  });

  it("does not group across caller-provided atomic span boundaries without punctuation", () => {
    const text = "Open foo now.";
    const start = text.indexOf("foo");
    const end = start + "foo".length;

    expect(groupTextsWithAtomicSpans(text, [{ start, end }])).toEqual(["Open", "foo", "now"]);
  });

  it("does not cross newline boundaries", () => {
    expect(groupTexts("The repo is ready\nA test passed")).toEqual([
      "The repo",
      "is ready",
      "A test",
      "passed",
    ]);
  });

  it("allows long technical tokens to remain one group", () => {
    const text = "apps/server/src/readAloud/localAiToolsSession.ts";

    expect(groupTexts(text)).toEqual([text]);
  });

  it("maps time to containing group", () => {
    expect(highlightGroupForTime("The repo is ready.", 0.1, 1).groupIndex).toBe(0);
    expect(highlightGroupForTime("The repo is ready.", 0.8, 1).groupIndex).toBe(1);
  });
});
