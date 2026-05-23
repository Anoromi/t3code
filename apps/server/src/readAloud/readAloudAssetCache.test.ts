import { describe, expect, it, vi } from "vitest";

import { InMemoryReadAloudAssetCache } from "./readAloudAssetCache.ts";

describe("InMemoryReadAloudAssetCache", () => {
  it("stores and returns raw assets by key", () => {
    let now = 1_000;
    const cache = new InMemoryReadAloudAssetCache({ now: () => now });
    cache.putRaw("raw-1", {
      rawCacheKey: "raw-1",
      generationId: "generation-1",
      audioPath: "/tmp/raw.wav",
      timings: [],
      audioSeconds: 1,
      wordCount: 2,
      actualWpm: 120,
    });

    now += 10;
    expect(cache.getRaw("raw-1")).toMatchObject({
      rawCacheKey: "raw-1",
      lastAccessedAtMs: 1_010,
    });
  });

  it("stores and returns tempo assets by raw key and WPM", () => {
    const cache = new InMemoryReadAloudAssetCache();
    cache.putTempo("raw-1", 350, {
      audioPath: "/tmp/tempo.wav",
      renderedWpm: 350,
      tempoFactor: 2,
    });

    expect(cache.getTempo("raw-1", 350)).toMatchObject({
      audioPath: "/tmp/tempo.wav",
      renderedWpm: 350,
      tempoFactor: 2,
    });
    expect(cache.getTempo("raw-1", 500)).toBe(null);
  });

  it("deletes tempo assets by raw key and WPM", () => {
    const cache = new InMemoryReadAloudAssetCache();
    cache.putTempo("raw-1", 350, {
      audioPath: "/tmp/tempo.wav",
      renderedWpm: 350,
      tempoFactor: 2,
    });

    cache.deleteTempo("raw-1", 350);

    expect(cache.getTempo("raw-1", 350)).toBe(null);
  });

  it("prunes expired raw and tempo assets", async () => {
    let now = 1_000;
    const removePath = vi.fn(async () => undefined);
    const cache = new InMemoryReadAloudAssetCache({ ttlMs: 100, now: () => now, removePath });
    cache.putRaw("raw-1", {
      rawCacheKey: "raw-1",
      generationId: "generation-1",
      audioPath: "/tmp/raw.wav",
      timings: [],
      audioSeconds: null,
      wordCount: null,
      actualWpm: null,
    });
    cache.putTempo("raw-1", 350, {
      audioPath: "/tmp/tempo.wav",
      renderedWpm: 350,
      tempoFactor: 1,
    });

    now = 1_200;
    expect(cache.getRaw("raw-1")).toBe(null);
    await cache.prune();
    expect(removePath).toHaveBeenCalledWith("/tmp/raw.wav");
    expect(removePath).toHaveBeenCalledWith("/tmp/tempo.wav");
  });
});
