import { describe, expect, it } from "vitest";

import {
  computeReadAloudCodeHoldMetrics,
  formatReadAloudCodeSizeLabel,
  READ_ALOUD_CODE_HOLD_MS,
} from "./readAloudSilentUnits";

describe("computeReadAloudCodeHoldMetrics", () => {
  it("uses a fixed hold for very short code", () => {
    expect(computeReadAloudCodeHoldMetrics("x")).toEqual({
      charCount: 1,
      lineCount: 1,
      holdMs: READ_ALOUD_CODE_HOLD_MS,
      label: "1 line",
    });
  });

  it("keeps the fixed hold for medium code", () => {
    const code = Array.from({ length: 6 }, (_, index) => `const value${index} = "abc";`).join("\n");
    const metrics = computeReadAloudCodeHoldMetrics(code);

    expect(metrics.lineCount).toBe(6);
    expect(metrics.holdMs).toBe(READ_ALOUD_CODE_HOLD_MS);
  });

  it("keeps the fixed hold for very large code", () => {
    const code = Array.from({ length: 80 }, (_, index) => `const value${index} = "long";`).join(
      "\n",
    );

    expect(computeReadAloudCodeHoldMetrics(code).holdMs).toBe(READ_ALOUD_CODE_HOLD_MS);
  });
});

describe("formatReadAloudCodeSizeLabel", () => {
  it("formats one line", () => {
    expect(formatReadAloudCodeSizeLabel({ lineCount: 1, charCount: 100 })).toBe("1 line");
  });

  it("formats multiple lines", () => {
    expect(formatReadAloudCodeSizeLabel({ lineCount: 2, charCount: 20 })).toBe("2 lines");
  });
});
