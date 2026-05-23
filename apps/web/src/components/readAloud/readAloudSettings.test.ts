import { describe, expect, it } from "vitest";

import { DEFAULT_READ_ALOUD_TARGET_WPM, normalizeReadAloudWpm } from "./readAloudSettings";

describe("normalizeReadAloudWpm", () => {
  it("clamps below the minimum WPM", () => {
    expect(normalizeReadAloudWpm(80)).toBe(120);
  });

  it("clamps above the maximum WPM", () => {
    expect(normalizeReadAloudWpm(1200)).toBe(1000);
  });

  it("rounds to the nearest 10 WPM", () => {
    expect(normalizeReadAloudWpm(356)).toBe(360);
  });

  it("uses the default WPM for non-finite values", () => {
    expect(normalizeReadAloudWpm(Number.NaN)).toBe(DEFAULT_READ_ALOUD_TARGET_WPM);
  });
});
