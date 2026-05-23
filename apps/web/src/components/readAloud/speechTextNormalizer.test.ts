import { describe, expect, it } from "vitest";

import { normalizeSpeechText, normalizeSpeechTextWithAlignment } from "./speechTextNormalizer";

describe("normalizeSpeechText", () => {
  it.each([
    ["apps/server/src/ws.ts", "apps ws dot ts"],
    ["bun run dev:web", "bun run dev web"],
    ["@anoromi/local-ai-tools", "anoromi local ai tools"],
    ["AGENTS.md", "agents dot md"],
    ["foo.test.ts", "foo test dot ts"],
    ["localhost:5173", "localhost 5173"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeSpeechText(input)).toBe(expected);
  });

  it("does not return leading or trailing whitespace", () => {
    expect(normalizeSpeechText("  `AGENTS.md`  ")).toBe("agents dot md");
  });

  it("maps expanded AGENTS.md speech tokens back to the original display token", () => {
    const result = normalizeSpeechTextWithAlignment("Read AGENTS.md before continuing.");

    expect(result.speechText).toBe("Read agents dot md before continuing.");
    const agentsRange = { displayStart: 5, displayEnd: 14 };
    expect(result.alignments.filter((alignment) => alignment.displayTokenIndex === 1)).toEqual([
      expect.objectContaining({ speechText: "agents", ...agentsRange }),
      expect.objectContaining({ speechText: "dot", ...agentsRange }),
      expect.objectContaining({ speechText: "md", ...agentsRange }),
    ]);
  });

  it("maps expanded path speech tokens back to the original display token", () => {
    const result = normalizeSpeechTextWithAlignment("Open apps/server/src/ws.ts now.");

    expect(result.speechText).toBe("Open apps ws dot ts now.");
    const pathRange = { displayStart: 5, displayEnd: 26 };
    expect(result.alignments.filter((alignment) => alignment.displayTokenIndex === 1)).toEqual([
      expect.objectContaining({ speechText: "apps", ...pathRange }),
      expect.objectContaining({ speechText: "ws", ...pathRange }),
      expect.objectContaining({ speechText: "dot", ...pathRange }),
      expect.objectContaining({ speechText: "ts", ...pathRange }),
    ]);
  });

  it("maps expanded package speech tokens back to the original display token", () => {
    const result = normalizeSpeechTextWithAlignment("Use @anoromi/local-ai-tools here.");

    expect(result.speechText).toBe("Use anoromi local ai tools here.");
    const packageRange = { displayStart: 4, displayEnd: 27 };
    expect(result.alignments.filter((alignment) => alignment.displayTokenIndex === 1)).toEqual([
      expect.objectContaining({ speechText: "anoromi", ...packageRange }),
      expect.objectContaining({ speechText: "local", ...packageRange }),
      expect.objectContaining({ speechText: "ai", ...packageRange }),
      expect.objectContaining({ speechText: "tools", ...packageRange }),
    ]);
  });

  it("maps command-ish token expansions back to the original display token", () => {
    const result = normalizeSpeechTextWithAlignment("Run bun run dev:web.");

    expect(result.speechText).toBe("Run bun run dev web.");
    const commandRange = { displayStart: 12, displayEnd: 19 };
    expect(result.alignments.filter((alignment) => alignment.displayTokenIndex === 3)).toEqual([
      expect.objectContaining({ speechText: "dev", ...commandRange }),
      expect.objectContaining({ speechText: "web", ...commandRange }),
    ]);
  });
});
