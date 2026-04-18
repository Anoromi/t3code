import { describe, expect, it } from "vitest";

import {
  appendPendingTerminalProcessEvent,
  MAX_COALESCED_OUTPUT_CHARS,
} from "./terminalOutputCoalescing.js";

describe("terminalOutputCoalescing", () => {
  it("coalesces adjacent output chunks under the cap", () => {
    const queue: Array<{ type: "output"; data: string } | { type: "exit"; code: number }> = [];

    appendPendingTerminalProcessEvent(queue, { type: "output", data: "first\n" });
    appendPendingTerminalProcessEvent(queue, { type: "output", data: "second\n" });

    expect(queue).toEqual([{ type: "output", data: "first\nsecond\n" }]);
  });

  it("does not merge output across non-output events", () => {
    const queue: Array<{ type: "output"; data: string } | { type: "exit"; code: number }> = [];

    appendPendingTerminalProcessEvent(queue, { type: "output", data: "before\n" });
    appendPendingTerminalProcessEvent(queue, { type: "exit", code: 0 });
    appendPendingTerminalProcessEvent(queue, { type: "output", data: "after\n" });

    expect(queue).toEqual([
      { type: "output", data: "before\n" },
      { type: "exit", code: 0 },
      { type: "output", data: "after\n" },
    ]);
  });

  it("respects the maximum coalesced output size", () => {
    const queue: Array<{ type: "output"; data: string }> = [];
    const firstChunk = "a".repeat(40_000);
    const secondChunk = "b".repeat(40_000);

    appendPendingTerminalProcessEvent(queue, { type: "output", data: firstChunk });
    appendPendingTerminalProcessEvent(queue, { type: "output", data: secondChunk });

    expect(queue).toHaveLength(2);
    expect(queue[0]?.data.length).toBeLessThanOrEqual(MAX_COALESCED_OUTPUT_CHARS);
    expect(queue[0]?.data).toBe(firstChunk);
    expect(queue[1]?.data).toBe(secondChunk);
  });
});
