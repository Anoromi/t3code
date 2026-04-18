import { describe, expect, it } from "vitest";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  composerTriggersEqual,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
  normalizeReasoningCommandAlias,
  normalizeReasoningValue,
  parseComposerMenuSlashCommandQuery,
  parseStandaloneComposerSlashCommand,
  replaceTextRange,
} from "./composer-logic";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("composerTriggersEqual", () => {
  it("treats matching null triggers as equal", () => {
    expect(composerTriggersEqual(null, null)).toBe(true);
  });

  it("compares trigger fields", () => {
    const trigger = {
      kind: "path" as const,
      query: "src",
      rangeStart: 4,
      rangeEnd: 8,
    };

    expect(composerTriggersEqual(trigger, { ...trigger })).toBe(true);
    expect(composerTriggersEqual(trigger, { ...trigger, query: "app" })).toBe(false);
    expect(composerTriggersEqual(trigger, { ...trigger, rangeEnd: 9 })).toBe(false);
    expect(composerTriggersEqual(trigger, null)).toBe(false);
  });
});

describe("detectComposerTrigger", () => {
  it("detects @path trigger at cursor", () => {
    const text = "Please check @src/com";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "path",
      query: "src/com",
      rangeStart: "Please check ".length,
      rangeEnd: text.length,
    });
  });

  it("detects slash command token while typing command name", () => {
    const text = "/mo";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "mo",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects slash model query after /model", () => {
    const text = "/model spark";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-model",
      query: "spark",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects non-model slash commands while typing", () => {
    const text = "/pl";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "pl",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps slash command detection active for provider commands", () => {
    const text = "/rev";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "rev",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects fast mode slash command while typing", () => {
    const text = "/fa";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "fa",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps reasoning slash command detection active while typing a value", () => {
    const text = "/reasoning h";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "reasoning h",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects $skill trigger at cursor", () => {
    const text = "Use $gh-fi";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "skill",
      query: "gh-fi",
      rangeStart: "Use ".length,
      rangeEnd: text.length,
    });
  });

  it("detects /re while typing", () => {
    const text = "/re";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "re",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects /r while typing", () => {
    const text = "/r";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "r",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects /branch while typing", () => {
    const text = "/branch";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "branch",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps the /branch trigger open after a trailing space", () => {
    const text = "/branch ";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "branch ",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects /worktree while typing", () => {
    const text = "/worktree";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "worktree",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps the /worktree trigger open after a trailing space", () => {
    const text = "/worktree ";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "worktree ",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("keeps the reasoning trigger open after a trailing space", () => {
    const text = "/reasoning ";
    const trigger = detectComposerTrigger(text, text.length);

    expect(trigger).toEqual({
      kind: "slash-command",
      query: "reasoning ",
      rangeStart: 0,
      rangeEnd: text.length,
    });
  });

  it("detects @path trigger in the middle of existing text", () => {
    // User typed @ between "inspect " and "in this sentence"
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).toEqual({
      kind: "path",
      query: "",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterAt,
    });
  });

  it("detects @path trigger with query typed mid-text", () => {
    // User typed @sr between "inspect " and "in this sentence"
    const text = "Please inspect @srin this sentence";
    const cursorAfterQuery = "Please inspect @sr".length;

    const trigger = detectComposerTrigger(text, cursorAfterQuery);
    expect(trigger).toEqual({
      kind: "path",
      query: "sr",
      rangeStart: "Please inspect ".length,
      rangeEnd: cursorAfterQuery,
    });
  });

  it("detects trigger with true cursor even when regex-based mention detection would false-match", () => {
    // MENTION_TOKEN_REGEX can false-match plain text like "@in" as a mention.
    // The fix bypasses it by computing the expanded cursor from the Lexical node tree.
    const text = "Please inspect @in this sentence";
    const cursorAfterAt = "Please inspect @".length;

    const trigger = detectComposerTrigger(text, cursorAfterAt);
    expect(trigger).not.toBeNull();
    expect(trigger?.kind).toBe("path");
    expect(trigger?.query).toBe("");
  });
});

describe("replaceTextRange", () => {
  it("replaces a text range and returns new cursor", () => {
    const replaced = replaceTextRange("hello @src", 6, 10, "");
    expect(replaced).toEqual({
      text: "hello ",
      cursor: 6,
    });
  });
});

describe("parseStandaloneComposerSlashCommand", () => {
  it("parses built-in standalone commands", () => {
    expect(parseStandaloneComposerSlashCommand("/plan")).toBe("plan");
    expect(parseStandaloneComposerSlashCommand("/default")).toBe("default");
    expect(parseStandaloneComposerSlashCommand("/fast")).toBe("fast");
    expect(parseStandaloneComposerSlashCommand("/fork")).toBe("fork");
  });

  it("parses reasoning standalone commands", () => {
    expect(parseStandaloneComposerSlashCommand("/reasoning xh")).toEqual({
      kind: "reasoning",
      effort: "xhigh",
    });
    expect(parseStandaloneComposerSlashCommand("/r h")).toEqual({
      kind: "reasoning",
      effort: "high",
    });
    expect(parseStandaloneComposerSlashCommand("/reasoning high")).toEqual({
      kind: "reasoning",
      effort: "high",
    });
  });

  it("does not parse commands with trailing text as standalone slash commands", () => {
    expect(parseStandaloneComposerSlashCommand("/fast please")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("/plan explain this")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("/fork later")).toBeNull();
  });

  it("ignores model and provider slash commands", () => {
    expect(parseStandaloneComposerSlashCommand("/model")).toBeNull();
    expect(parseStandaloneComposerSlashCommand("/review")).toBeNull();
  });

  it("parses /reasoning xhigh as a standalone slash command", () => {
    expect(parseStandaloneComposerSlashCommand("/reasoning xhigh")).toEqual({
      kind: "reasoning",
      effort: "xhigh",
    });
  });

  it("does not parse /reasoning without a value", () => {
    expect(parseStandaloneComposerSlashCommand("/reasoning")).toBeNull();
  });

  it("does not parse /reasoning please", () => {
    expect(parseStandaloneComposerSlashCommand("/reasoning please")).toBeNull();
  });

  it("does not parse /reasoning high now", () => {
    expect(parseStandaloneComposerSlashCommand("/reasoning high now")).toBeNull();
  });

  it("does not parse invalid reasoning abbreviations", () => {
    expect(parseStandaloneComposerSlashCommand("/r hh")).toBeNull();
  });

  it("does not parse /branch as a standalone slash command", () => {
    expect(parseStandaloneComposerSlashCommand("/branch")).toBeNull();
  });

  it("does not parse /worktree as a standalone slash command", () => {
    expect(parseStandaloneComposerSlashCommand("/worktree")).toBeNull();
  });
});

describe("parseComposerMenuSlashCommandQuery", () => {
  it("parses /branch query text", () => {
    expect(parseComposerMenuSlashCommandQuery("branch feat")).toEqual({
      command: "branch",
      valueQuery: "feat",
    });
  });

  it("parses bare /branch", () => {
    expect(parseComposerMenuSlashCommandQuery("branch")).toEqual({
      command: "branch",
      valueQuery: "",
    });
  });

  it("parses /worktree query text", () => {
    expect(parseComposerMenuSlashCommandQuery("worktree loc")).toEqual({
      command: "worktree",
      valueQuery: "loc",
    });
  });

  it("preserves named worktree branch casing", () => {
    expect(parseComposerMenuSlashCommandQuery("worktree Feature/One")).toEqual({
      command: "worktree",
      valueQuery: "Feature/One",
    });
  });

  it("parses bare /worktree", () => {
    expect(parseComposerMenuSlashCommandQuery("worktree")).toEqual({
      command: "worktree",
      valueQuery: "",
    });
  });
});

describe("reasoning helpers", () => {
  it("normalizes the /r alias to reasoning", () => {
    expect(normalizeReasoningCommandAlias("r")).toBe("reasoning");
  });

  it("normalizes reasoning abbreviations", () => {
    expect(normalizeReasoningValue("xh")).toBe("xhigh");
    expect(normalizeReasoningValue("h")).toBe("high");
    expect(normalizeReasoningValue("m")).toBe("medium");
    expect(normalizeReasoningValue("l")).toBe("low");
  });
});

describe("expandCollapsedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(expandCollapsedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps collapsed mention cursor to expanded text cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterMention)).toBe(
      expandedCursorAfterMention,
    );
  });

  it("allows path trigger detection to close after selecting a mention", () => {
    const text = "what's in my @AGENTS.md ";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursor = expandCollapsedComposerCursor(text, collapsedCursorAfterMention);

    expect(detectComposerTrigger(text, expandedCursor)).toBeNull();
  });

  it("maps collapsed skill cursor to expanded text cursor", () => {
    const text = "run $review-follow-up then";
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = "run $review-follow-up ".length;

    expect(expandCollapsedComposerCursor(text, collapsedCursorAfterSkill)).toBe(
      expandedCursorAfterSkill,
    );
  });
});

describe("collapseExpandedComposerCursor", () => {
  it("keeps cursor unchanged when no mention segment is present", () => {
    expect(collapseExpandedComposerCursor("plain text", 5)).toBe(5);
  });

  it("maps expanded mention cursor back to collapsed cursor", () => {
    const text = "what's in my @AGENTS.md fsfdas";
    const collapsedCursorAfterMention = "what's in my ".length + 2;
    const expandedCursorAfterMention = "what's in my @AGENTS.md ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterMention)).toBe(
      collapsedCursorAfterMention,
    );
  });

  it("keeps replacement cursors aligned when another mention already exists earlier", () => {
    const text = "open @AGENTS.md then @src/index.ts ";
    const expandedCursor = text.length;
    const collapsedCursor = collapseExpandedComposerCursor(text, expandedCursor);

    expect(collapsedCursor).toBe("open ".length + 1 + " then ".length + 2);
    expect(expandCollapsedComposerCursor(text, collapsedCursor)).toBe(expandedCursor);
  });

  it("maps expanded skill cursor back to collapsed cursor", () => {
    const text = "run $review-follow-up then";
    const collapsedCursorAfterSkill = "run ".length + 2;
    const expandedCursorAfterSkill = "run $review-follow-up ".length;

    expect(collapseExpandedComposerCursor(text, expandedCursorAfterSkill)).toBe(
      collapsedCursorAfterSkill,
    );
  });
});

describe("clampCollapsedComposerCursor", () => {
  it("clamps to collapsed prompt length when mentions are present", () => {
    const text = "open @AGENTS.md then ";

    expect(clampCollapsedComposerCursor(text, text.length)).toBe(
      "open ".length + 1 + " then ".length,
    );
    expect(clampCollapsedComposerCursor(text, Number.POSITIVE_INFINITY)).toBe(
      "open ".length + 1 + " then ".length,
    );
  });
});

describe("replaceTextRange trailing space consumption", () => {
  it("double space after insertion when replacement ends with space", () => {
    // Simulates: "and then |@AG| summarize" where | marks replacement range
    // The replacement is "@AGENTS.md " (with trailing space)
    // But if we don't extend rangeEnd, the existing space stays
    const text = "and then @AG summarize";
    const rangeStart = "and then ".length;
    const rangeEnd = "and then @AG".length;

    // Without consuming trailing space: double space
    const withoutConsume = replaceTextRange(text, rangeStart, rangeEnd, "@AGENTS.md ");
    expect(withoutConsume.text).toBe("and then @AGENTS.md  summarize");

    // With consuming trailing space: single space
    const extendedEnd = text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
    const withConsume = replaceTextRange(text, rangeStart, extendedEnd, "@AGENTS.md ");
    expect(withConsume.text).toBe("and then @AGENTS.md summarize");
  });
});

describe("isCollapsedCursorAdjacentToInlineToken", () => {
  it("returns false when no mention exists", () => {
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken("plain text", 6, "right")).toBe(false);
  });

  it("keeps @query typing non-adjacent while no mention pill exists", () => {
    const text = "hello @pac";
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, text.length, "right")).toBe(false);
  });

  it("detects left adjacency only when cursor is directly after a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "left")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd + 1, "left")).toBe(false);
  });

  it("detects right adjacency only when cursor is directly before a mention", () => {
    const text = "open @AGENTS.md next";
    const mentionStart = "open ".length;
    const mentionEnd = mentionStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart, "right")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionEnd, "right")).toBe(false);
    expect(isCollapsedCursorAdjacentToInlineToken(text, mentionStart - 1, "right")).toBe(false);
  });

  it("treats terminal pills as inline tokens for adjacency checks", () => {
    const text = `open ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} next`;
    const tokenStart = "open ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });

  it("treats skill pills as inline tokens for adjacency checks", () => {
    const text = "run $review-follow-up next";
    const tokenStart = "run ".length;
    const tokenEnd = tokenStart + 1;

    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenEnd, "left")).toBe(true);
    expect(isCollapsedCursorAdjacentToInlineToken(text, tokenStart, "right")).toBe(true);
  });
});
