import { describe, expect, it } from "vitest";

import {
  appendPendingTerminalProcessEvent,
  MAX_COALESCED_OUTPUT_CHARS,
} from "./terminalOutputCoalescing.ts";

describe("terminalOutputCoalescing", () => {
  it("coalesces adjacent output events", () => {
    const queue: Array<{ type: "output"; data: string } | { type: "exit" }> = [];

    appendPendingTerminalProcessEvent(queue, { type: "output", data: "hello" });
    appendPendingTerminalProcessEvent(queue, { type: "output", data: " world" });

    expect(queue).toEqual([{ type: "output", data: "hello world" }]);
  });

  it("does not coalesce across non-output events", () => {
    const queue: Array<{ type: "output"; data: string } | { type: "exit" }> = [];

    appendPendingTerminalProcessEvent(queue, { type: "output", data: "a" });
    appendPendingTerminalProcessEvent(queue, { type: "exit" });
    appendPendingTerminalProcessEvent(queue, { type: "output", data: "b" });

    expect(queue).toEqual([
      { type: "output", data: "a" },
      { type: "exit" },
      { type: "output", data: "b" },
    ]);
  });

  it("starts a new output event when the coalesced chunk would be too large", () => {
    const queue: Array<{ type: "output"; data: string }> = [];

    appendPendingTerminalProcessEvent(queue, {
      type: "output",
      data: "a".repeat(MAX_COALESCED_OUTPUT_CHARS),
    });
    appendPendingTerminalProcessEvent(queue, { type: "output", data: "b" });

    expect(queue).toHaveLength(2);
  });
});
