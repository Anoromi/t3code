import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  READ_ALOUD_CONTEXT_MENU_ITEMS,
  collectChunks,
  computeReadAloudScrollDelta,
  createSilentCodeChunk,
  displayWordIndexForReadAloudTimings,
  resolveStartChunk,
  shouldScrollReadAloudRectIntoView,
  splitInitialChunkForFastStart,
  wordIndexForReadAloudTimings,
  type ReadAloudChunk,
} from "./ThreadReadAloudProvider";
import { computeReadAloudCodeHoldMetrics } from "./readAloudSilentUnits";
import { normalizeSpeechTextWithAlignment } from "./speechTextNormalizer";

class TestText {
  readonly nodeType = 3;
  parentElement: TestElement | null = null;

  constructor(readonly textContent: string) {}
}

class TestElement {
  readonly children: TestElement[] = [];
  readonly childNodes: Array<TestElement | TestText> = [];
  readonly dataset: Record<string, string | undefined> = {};
  className = "";
  parentElement: TestElement | null = null;

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.childNodes.map((node) => node.textContent ?? "").join("");
  }

  set textContent(value: string) {
    const text = new TestText(value);
    text.parentElement = this;
    this.children.length = 0;
    this.childNodes.length = 0;
    this.childNodes.push(text);
  }

  append(...nodes: Array<TestElement | string>): void {
    for (const node of nodes) {
      const nextNode = typeof node === "string" ? new TestText(node) : node;
      nextNode.parentElement = this;
      this.childNodes.push(nextNode);
      if (nextNode instanceof TestElement) {
        this.children.push(nextNode);
      }
    }
  }

  contains(node: TestElement): boolean {
    return node === this || this.children.some((child) => child.contains(node));
  }

  getAttribute(name: string): string | null {
    if (name === "class") return this.className;
    if (name === "data-read-aloud-skip") return this.dataset.readAloudSkip ?? null;
    if (name === "contenteditable") return null;
    return null;
  }

  getAttributeNames(): string[] {
    const names: string[] = [];
    if (this.className.length > 0) names.push("class");
    if (this.dataset.readAloudSkip !== undefined) names.push("data-read-aloud-skip");
    return names;
  }

  hasAttribute(name: string): boolean {
    return this.getAttribute(name) !== null;
  }

  querySelectorAll(selector: string): TestElement[] {
    const selectors = selector.split(",").map((part) => part.trim());
    const matches: TestElement[] = [];
    const visit = (element: TestElement) => {
      if (selectors.some((part) => element.matches(part))) {
        matches.push(element);
      }
      for (const child of element.children) {
        visit(child);
      }
    };
    for (const child of this.children) {
      visit(child);
    }
    return matches;
  }

  closest(selector: string): TestElement | null {
    const selectors = selector.split(",").map((part) => part.trim());
    const findClosest = (element: TestElement | null): TestElement | null => {
      if (!element) return null;
      if (selectors.some((part) => element.matches(part))) {
        return element;
      }
      return findClosest(element.parentElement);
    };
    return findClosest(this);
  }

  matches(selector: string): boolean {
    if (selector === ".chat-markdown-codeblock") {
      return this.className.split(/\s+/).includes("chat-markdown-codeblock");
    }
    if (selector === ".shiki") {
      return this.className.split(/\s+/).includes("shiki");
    }
    if (selector === "#t3code-read-aloud-code-overlay") {
      return false;
    }
    if (selector === "[data-read-aloud-skip]" || selector === "[data-read-aloud-skip='true']") {
      return this.dataset.readAloudSkip !== undefined;
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
}

function installTestDom(): {
  readonly createElement: (tagName: string) => TestElement;
  caretRangeFromPoint:
    | (() => { readonly startContainer: TestText; readonly startOffset: number })
    | null;
} {
  const body = new TestElement("body");
  const testDocument = {
    body,
    createElement: (tagName: string) => new TestElement(tagName),
    querySelector: (selector: string) => body.querySelectorAll(selector)[0] ?? null,
    createRange: () => ({
      setStart: vi.fn(),
      collapse: vi.fn(),
    }),
    createTreeWalker: (root: TestElement) => {
      const textNodes: TestText[] = [];
      const visit = (node: TestElement | TestText) => {
        if (node instanceof TestText) {
          textNodes.push(node);
          return;
        }
        for (const child of node.childNodes) {
          visit(child);
        }
      };
      visit(root);
      let index = -1;
      return {
        currentNode: null as TestText | null,
        nextNode() {
          index += 1;
          this.currentNode = textNodes[index] ?? null;
          return this.currentNode !== null;
        },
      };
    },
    caretRangeFromPoint: null as
      | (() => { readonly startContainer: TestText; readonly startOffset: number })
      | null,
  };
  vi.stubGlobal("HTMLElement", TestElement);
  vi.stubGlobal("Text", TestText);
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  vi.stubGlobal("document", testDocument);
  return testDocument;
}

function makeChunk(text: string, blockStartOffset = 0): ReadAloudChunk {
  const normalized = normalizeSpeechTextWithAlignment(text);
  return {
    block: {} as HTMLElement,
    id: "test-chunk",
    kind: "speech",
    text,
    speechText: normalized.speechText,
    speechTokenAlignments: normalized.alignments,
    blockStartOffset,
  };
}

function makeElementChunk(block: HTMLElement, text: string, blockStartOffset = 0): ReadAloudChunk {
  const normalized = normalizeSpeechTextWithAlignment(text);
  return {
    block,
    id: "test-chunk",
    kind: "speech",
    text,
    speechText: normalized.speechText,
    speechTokenAlignments: normalized.alignments,
    blockStartOffset,
  };
}

function contextMenuEvent(target: HTMLElement): React.MouseEvent<HTMLElement> {
  return {
    target,
    clientX: 0,
    clientY: 0,
  } as unknown as React.MouseEvent<HTMLElement>;
}

describe("code block read-aloud units", () => {
  beforeEach(() => {
    installTestDom();
  });

  it("does not allow starting read-aloud from a pre block", () => {
    const root = document.createElement("div");
    const pre = document.createElement("pre");
    pre.textContent = "bun run dev";
    root.append(pre);

    expect(resolveStartChunk(contextMenuEvent(pre), root)).toBeNull();
  });

  it("keeps inline code start behavior on the containing paragraph", () => {
    const root = document.createElement("div");
    const paragraph = document.createElement("p");
    paragraph.append("Run ");
    const code = document.createElement("code");
    code.textContent = "bun run dev:web";
    paragraph.append(code, " now.");
    root.append(paragraph);

    const textNode = code.childNodes[0] as unknown as TestText;
    const testDocument = document as unknown as ReturnType<typeof installTestDom>;
    testDocument.caretRangeFromPoint = () => ({ startContainer: textNode, startOffset: 0 });

    const chunk = resolveStartChunk(contextMenuEvent(code), root);

    expect(chunk).toMatchObject({
      kind: "speech",
      block: paragraph,
      text: "bun run dev:web now.",
      atomicSpans: [{ start: 0, end: "bun run dev:web".length }],
    });
  });

  it("stores inline code spans for following prose chunks", () => {
    const root = document.createElement("div");
    const first = document.createElement("p");
    first.textContent = "Start here.";
    const next = document.createElement("p");
    next.append("Use ");
    const code = document.createElement("code");
    code.textContent = "T3CODE_STATE_DIR";
    next.append(code, " then continue.");
    root.append(first, next);

    const chunks = collectChunks(root, makeElementChunk(first, "Start here."));

    expect(chunks[1]).toMatchObject({
      kind: "speech",
      block: next,
      text: "Use T3CODE_STATE_DIR then continue.",
      atomicSpans: [{ start: "Use ".length, end: "Use T3CODE_STATE_DIR".length }],
    });
  });

  it("creates silent code chunks with computed hold metadata", () => {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-markdown-codeblock";
    wrapper.dataset.readAloudCodeFocusKey = "message:test:code:0";
    const pre = document.createElement("pre");
    pre.textContent = "\n  bun run dev\n";
    wrapper.append(pre);
    const chunk = createSilentCodeChunk(pre);
    const metrics = computeReadAloudCodeHoldMetrics("bun run dev");

    expect(chunk).toMatchObject({
      kind: "silent",
      block: pre,
      text: "bun run dev",
      speechText: "",
      speechTokenAlignments: [],
      blockStartOffset: 3,
      holdMs: metrics.holdMs,
      silentReason: "code-block",
      silentLabel: metrics.label,
      codeFocusKey: "message:test:code:0",
    });
  });

  it("drops empty code blocks", () => {
    const pre = document.createElement("pre");
    pre.textContent = " \n ";

    expect(createSilentCodeChunk(pre)).toBeNull();
  });

  it("collects following code blocks as silent chunks and continues to later prose", () => {
    const root = document.createElement("div");
    const first = document.createElement("p");
    first.textContent = "Start here.";
    const pre = document.createElement("pre");
    pre.textContent = "bun run dev";
    const next = document.createElement("p");
    next.textContent = "Continue after code.";
    root.append(first, pre, next);

    const chunks = collectChunks(root, makeElementChunk(first, "Start here."));

    expect(chunks.map((chunk) => chunk.kind)).toEqual(["speech", "silent", "speech"]);
    expect(chunks[1]).toMatchObject({
      kind: "silent",
      block: pre,
      text: "bun run dev",
      speechText: "",
      silentReason: "code-block",
    });
    expect(chunks[2]).toMatchObject({
      kind: "speech",
      block: next,
      text: "Continue after code.",
    });
  });

  it("excludes code blocks inside skipped containers", () => {
    const root = document.createElement("div");
    const first = document.createElement("p");
    first.textContent = "Start here.";
    const skipped = document.createElement("div");
    skipped.dataset.readAloudSkip = "true";
    const pre = document.createElement("pre");
    pre.textContent = "ignored";
    skipped.append(pre);
    const next = document.createElement("p");
    next.textContent = "Continue.";
    root.append(first, skipped, next);

    const chunks = collectChunks(root, makeElementChunk(first, "Start here."));

    expect(chunks.map((chunk) => chunk.text)).toEqual(["Start here.", "Continue."]);
  });

  it("does not create a fixed code overlay for silent chunks", () => {
    const wrapper = document.createElement("div");
    wrapper.className = "chat-markdown-codeblock";
    wrapper.dataset.readAloudCodeFocusKey = "message:test:code:0";
    const pre = document.createElement("pre");
    pre.textContent = "bun run dev";
    wrapper.append(pre);
    document.body.append(wrapper);

    expect(createSilentCodeChunk(pre)).toMatchObject({
      kind: "silent",
      codeFocusKey: "message:test:code:0",
    });
    expect(wrapper.dataset.readAloudCodeActive).toBeUndefined();
    expect(pre.dataset.readAloudCodeActive).toBeUndefined();
    expect(document.querySelector("#t3code-read-aloud-code-overlay")).toBeNull();
  });
});

describe("read-aloud context menu", () => {
  it("keeps the contextual read action available as Read from here", () => {
    expect(READ_ALOUD_CONTEXT_MENU_ITEMS).toEqual(
      expect.arrayContaining([{ id: "read-from-here", label: "Read from here" }]),
    );
  });
});

describe("splitInitialChunkForFastStart", () => {
  it("splits the initial chunk at punctuation", () => {
    const chunks = splitInitialChunkForFastStart(makeChunk("Wind moves. The lake answers.", 12));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      text: "Wind moves.",
      blockStartOffset: 12,
    });
    expect(chunks[1]).toMatchObject({
      text: "The lake answers.",
      blockStartOffset: 24,
    });
  });

  it("splits the initial chunk at a newline", () => {
    const chunks = splitInitialChunkForFastStart(
      makeChunk(
        "Wind moves through the pines,\nTelling secrets to the lake\nToo old to repeat.",
        5,
      ),
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Wind moves through the pines,",
      "Telling secrets to the lake\nToo old to repeat.",
    ]);
    expect(chunks[0]!.blockStartOffset).toBe(5);
    expect(chunks[1]!.blockStartOffset).toBe(35);
  });

  it("does not duplicate or skip text when trimming the remainder", () => {
    const source = "A match flares, then fades,  \n  But for one breath the whole dark";
    const chunks = splitInitialChunkForFastStart(makeChunk(source, 100));

    expect(chunks.map((chunk) => chunk.text).join(" ")).toBe(
      "A match flares, then fades, But for one breath the whole dark",
    );
    expect(chunks[1]!.blockStartOffset).toBe(132);
  });

  it("returns only the first chunk when there is no remainder", () => {
    const chunks = splitInitialChunkForFastStart(makeChunk("Only one sentence.", 3));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      text: "Only one sentence.",
      blockStartOffset: 3,
    });
  });

  it("does not split initial chunks inside technical tokens", () => {
    const chunks = splitInitialChunkForFastStart(
      makeChunk("Read AGENTS.md before continuing. Next sentence.", 0),
    );

    expect(chunks[0]).toMatchObject({
      text: "Read AGENTS.md before continuing.",
      blockStartOffset: 0,
    });
  });
});

describe("shouldScrollReadAloudRectIntoView", () => {
  it("does not scroll when the rect is inside the readable container zone", () => {
    expect(
      shouldScrollReadAloudRectIntoView(
        { top: 180, bottom: 300 },
        { top: 50, bottom: 650, height: 600 },
      ),
    ).toBe(false);
  });

  it("scrolls when the rect is above the top guard", () => {
    expect(
      shouldScrollReadAloudRectIntoView(
        { top: 120, bottom: 150 },
        { top: 50, bottom: 650, height: 600 },
      ),
    ).toBe(true);
  });

  it("scrolls when the rect bottom crosses the lower two-thirds trigger", () => {
    expect(
      shouldScrollReadAloudRectIntoView(
        { top: 430, bottom: 470 },
        { top: 50, bottom: 650, height: 600 },
      ),
    ).toBe(true);
  });

  it("does not depend on the window height", () => {
    expect(
      shouldScrollReadAloudRectIntoView(
        { top: 500, bottom: 530 },
        { top: 50, bottom: 650, height: 600 },
      ),
    ).toBe(true);
  });
});

describe("computeReadAloudScrollDelta", () => {
  it("returns a positive delta when the active rect is below center", () => {
    expect(
      computeReadAloudScrollDelta({
        rect: { top: 500, bottom: 540, height: 40 },
        containerRect: { top: 50, height: 600 },
      }),
    ).toBe(170);
  });

  it("returns a negative delta when the active rect is above center", () => {
    expect(
      computeReadAloudScrollDelta({
        rect: { top: 120, bottom: 160, height: 40 },
        containerRect: { top: 50, height: 600 },
      }),
    ).toBe(-210);
  });

  it("returns zero when the active rect is centered", () => {
    expect(
      computeReadAloudScrollDelta({
        rect: { top: 330, bottom: 370, height: 40 },
        containerRect: { top: 50, height: 600 },
      }),
    ).toBe(0);
  });

  it("supports an explicit target ratio", () => {
    expect(
      computeReadAloudScrollDelta({
        rect: { top: 330, bottom: 370, height: 40 },
        containerRect: { top: 50, height: 600 },
        targetRatio: 2 / 3,
      }),
    ).toBe(-100);
  });
});

describe("wordIndexForReadAloudTimings", () => {
  it("uses Local AI Tools chunk times instead of proportional duration", () => {
    expect(
      wordIndexForReadAloudTimings(
        "The repo is ready.",
        [
          {
            index: 0,
            text: "The",
            start: 0,
            end: 0.1,
            duration: 0.1,
            timing_basis: "local-ai-tools",
          },
          {
            index: 1,
            text: "repo",
            start: 0.1,
            end: 0.2,
            duration: 0.1,
            timing_basis: "local-ai-tools",
          },
          {
            index: 2,
            text: "is",
            start: 0.9,
            end: 1,
            duration: 0.1,
            timing_basis: "local-ai-tools",
          },
          {
            index: 3,
            text: "ready",
            start: 1,
            end: 1.1,
            duration: 0.1,
            timing_basis: "local-ai-tools",
          },
        ],
        0.95,
      ),
    ).toBe(2);
  });

  it("maps normalized timing words back to display words proportionally when counts differ", () => {
    expect(
      wordIndexForReadAloudTimings(
        "Open apps/server/src/ws.ts now.",
        [
          {
            index: 0,
            text: "Open",
            start: 0,
            end: 0.2,
            duration: 0.2,
            timing_basis: "local-ai-tools",
          },
          {
            index: 1,
            text: "apps ws dot ts",
            start: 0.2,
            end: 0.8,
            duration: 0.6,
            timing_basis: "local-ai-tools",
          },
          {
            index: 2,
            text: "now",
            start: 0.8,
            end: 1,
            duration: 0.2,
            timing_basis: "local-ai-tools",
          },
        ],
        0.85,
      ),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("displayWordIndexForReadAloudTimings", () => {
  it("holds an expanded technical token on the original display word", () => {
    const chunk = makeChunk("Read AGENTS.md before continuing.");
    const timings = chunk.speechTokenAlignments.map((alignment) => ({
      index: alignment.speechTokenIndex,
      text: alignment.speechText,
      start: alignment.speechTokenIndex,
      end: alignment.speechTokenIndex + 1,
      duration: 1,
      timing_basis: "local-ai-tools",
    }));

    expect(
      displayWordIndexForReadAloudTimings({
        displayText: chunk.text,
        timings,
        speechTokenAlignments: chunk.speechTokenAlignments,
        currentTime: 2.5,
      }),
    ).toBe(1);
    expect(
      displayWordIndexForReadAloudTimings({
        displayText: chunk.text,
        timings,
        speechTokenAlignments: chunk.speechTokenAlignments,
        currentTime: 3.5,
      }),
    ).toBe(1);
    expect(
      displayWordIndexForReadAloudTimings({
        displayText: chunk.text,
        timings,
        speechTokenAlignments: chunk.speechTokenAlignments,
        currentTime: 4.5,
      }),
    ).toBe(2);
  });

  it("does not jump ahead while a path token expansion is spoken", () => {
    const chunk = makeChunk("Open apps/server/src/ws.ts now.");
    const timings = chunk.speechTokenAlignments.map((alignment) => ({
      index: alignment.speechTokenIndex,
      text: alignment.speechText,
      start: alignment.speechTokenIndex,
      end: alignment.speechTokenIndex + 1,
      duration: 1,
      timing_basis: "local-ai-tools",
    }));

    expect(
      displayWordIndexForReadAloudTimings({
        displayText: chunk.text,
        timings,
        speechTokenAlignments: chunk.speechTokenAlignments,
        currentTime: 3.5,
      }),
    ).toBe(1);
    expect(
      displayWordIndexForReadAloudTimings({
        displayText: chunk.text,
        timings,
        speechTokenAlignments: chunk.speechTokenAlignments,
        currentTime: 5.5,
      }),
    ).toBe(2);
  });

  it("keeps plain text one-to-one", () => {
    const chunk = makeChunk("The repo is ready.");
    const timings = chunk.speechTokenAlignments.map((alignment) => ({
      index: alignment.speechTokenIndex,
      text: alignment.speechText,
      start: alignment.speechTokenIndex,
      end: alignment.speechTokenIndex + 1,
      duration: 1,
      timing_basis: "local-ai-tools",
    }));

    expect(
      displayWordIndexForReadAloudTimings({
        displayText: chunk.text,
        timings,
        speechTokenAlignments: chunk.speechTokenAlignments,
        currentTime: 2.5,
      }),
    ).toBe(2);
  });

  it("maps multi-word Local AI Tools timing entries through speech token alignment", () => {
    const chunk = makeChunk(
      "If you just want a quick sanity check of the repo, I can run make debug (per your AGENTS.md) and report any build errors.",
    );

    expect(
      displayWordIndexForReadAloudTimings({
        displayText: chunk.text,
        timings: [
          {
            index: 0,
            text: "If you just want a quick sanity check of the repo",
            start: 0,
            end: 1.1,
            duration: 1.1,
            timing_basis: "local-ai-tools",
          },
          {
            index: 1,
            text: "I can run make debug per your agents dot md and report any build errors",
            start: 1.1,
            end: 3,
            duration: 1.9,
            timing_basis: "local-ai-tools",
          },
        ],
        speechTokenAlignments: chunk.speechTokenAlignments,
        currentTime: 1.05,
      }),
    ).toBe(10);
  });

  it("holds the previous word during timing gaps after punctuation pauses", () => {
    const chunk = makeChunk(
      "If you just want a quick sanity check of the repo, I can run make debug (per your AGENTS.md) and report any build errors.",
    );
    const timings = chunk.speechTokenAlignments.map((alignment) => ({
      index: alignment.speechTokenIndex,
      text: alignment.speechText,
      start: alignment.speechTokenIndex * 0.1,
      end: alignment.speechTokenIndex * 0.1 + 0.05,
      duration: 0.05,
      timing_basis: "local-ai-tools",
    }));

    expect(
      displayWordIndexForReadAloudTimings({
        displayText: chunk.text,
        timings,
        speechTokenAlignments: chunk.speechTokenAlignments,
        currentTime: 1.075,
      }),
    ).toBe(10);
  });

  it("returns null after the final aligned timing instead of clamping to the final word", () => {
    const chunk = makeChunk("The repo is ready.");
    const timings = chunk.speechTokenAlignments.map((alignment) => ({
      index: alignment.speechTokenIndex,
      text: alignment.speechText,
      start: alignment.speechTokenIndex,
      end: alignment.speechTokenIndex + 0.5,
      duration: 0.5,
      timing_basis: "local-ai-tools",
    }));

    expect(
      displayWordIndexForReadAloudTimings({
        displayText: chunk.text,
        timings,
        speechTokenAlignments: chunk.speechTokenAlignments,
        currentTime: 10,
      }),
    ).toBeNull();
  });

  it("returns null when alignment is unavailable so callers can fall back", () => {
    expect(
      displayWordIndexForReadAloudTimings({
        displayText: "The repo is ready.",
        timings: [
          {
            index: 0,
            text: "The",
            start: 0,
            end: 1,
            duration: 1,
            timing_basis: "local-ai-tools",
          },
        ],
        speechTokenAlignments: [],
        currentTime: 0.5,
      }),
    ).toBeNull();
  });
});
