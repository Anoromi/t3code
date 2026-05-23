import { describe, expect, it } from "vitest";

import {
  buildAtempoFilter,
  renderReadAloudTempo,
  scaleReadAloudTimings,
} from "./readAloudTempo.ts";

describe("buildAtempoFilter", () => {
  it("builds a single atempo filter inside native range", () => {
    expect(buildAtempoFilter(1.25)).toBe("atempo=1.25000000");
  });

  it("chains filters above 2", () => {
    expect(buildAtempoFilter(4.2)).toBe("atempo=2.00000000,atempo=2.00000000,atempo=1.05000000");
  });

  it("chains filters below 0.5", () => {
    expect(buildAtempoFilter(0.3)).toBe("atempo=0.50000000,atempo=0.60000000");
  });
});

describe("scaleReadAloudTimings", () => {
  it("scales timings by tempo factor", () => {
    expect(
      scaleReadAloudTimings(
        [{ index: 0, text: "hello", start: 2, end: 4, duration: 2, timing_basis: "word" }],
        2,
      ),
    ).toEqual([{ index: 0, text: "hello", start: 1, end: 2, duration: 1, timing_basis: "word" }]);
  });
});

describe("renderReadAloudTempo", () => {
  it("surfaces ffmpeg failures as tempo render failures", async () => {
    await expect(
      renderReadAloudTempo({
        rawAudioPath: "/tmp/t3code-missing-read-aloud.wav",
        text: "hello world",
        audioSeconds: 1,
        wordCount: 2,
        targetWpm: 350,
        outputPath: "/tmp/t3code-missing-read-aloud-output.wav",
      }),
    ).rejects.toThrow("Audio tempo render failed");
  });
});
