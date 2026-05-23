// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import { rm } from "node:fs/promises";

import type { ReadAloudTimingChunk } from "./localAiToolsSession.ts";

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface RawReadAloudAsset {
  readonly rawCacheKey: string;
  readonly generationId: string;
  readonly audioPath: string;
  readonly timings: ReadAloudTimingChunk[];
  readonly audioSeconds: number | null;
  readonly wordCount: number | null;
  readonly actualWpm: number | null;
  readonly createdAtMs: number;
  readonly lastAccessedAtMs: number;
}

export interface TempoReadAloudAsset {
  readonly audioPath: string;
  readonly renderedWpm: number;
  readonly tempoFactor: number;
  readonly createdAtMs: number;
  readonly lastAccessedAtMs: number;
}

export interface ReadAloudAssetCache {
  getRaw(key: string): RawReadAloudAsset | null;
  putRaw(key: string, asset: Omit<RawReadAloudAsset, "createdAtMs" | "lastAccessedAtMs">): void;
  getTempo(rawKey: string, targetWpm: number): TempoReadAloudAsset | null;
  deleteTempo(rawKey: string, targetWpm: number): void;
  putTempo(
    rawKey: string,
    targetWpm: number,
    asset: Omit<TempoReadAloudAsset, "createdAtMs" | "lastAccessedAtMs">,
  ): void;
  prune(): Promise<void>;
  disposeGeneration(generationId: string): Promise<void>;
}

interface CacheOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly removePath?: (path: string) => Promise<void>;
}

function tempoKey(rawKey: string, targetWpm: number): string {
  return `${rawKey}\0${targetWpm}`;
}

export class InMemoryReadAloudAssetCache implements ReadAloudAssetCache {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly removePath: (path: string) => Promise<void>;
  private readonly rawAssets = new Map<string, RawReadAloudAsset>();
  private readonly tempoAssets = new Map<string, TempoReadAloudAsset>();

  constructor(options: CacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
    this.removePath =
      options.removePath ??
      ((path) => rm(path, { recursive: true, force: true }).then(() => undefined));
  }

  getRaw(key: string): RawReadAloudAsset | null {
    const asset = this.rawAssets.get(key);
    if (!asset || this.isExpired(asset.lastAccessedAtMs)) return null;
    const touched = { ...asset, lastAccessedAtMs: this.now() };
    this.rawAssets.set(key, touched);
    return touched;
  }

  putRaw(key: string, asset: Omit<RawReadAloudAsset, "createdAtMs" | "lastAccessedAtMs">): void {
    const now = this.now();
    this.rawAssets.set(key, { ...asset, createdAtMs: now, lastAccessedAtMs: now });
  }

  getTempo(rawKey: string, targetWpm: number): TempoReadAloudAsset | null {
    const key = tempoKey(rawKey, targetWpm);
    const asset = this.tempoAssets.get(key);
    if (!asset || this.isExpired(asset.lastAccessedAtMs)) return null;
    const touched = { ...asset, lastAccessedAtMs: this.now() };
    this.tempoAssets.set(key, touched);
    return touched;
  }

  deleteTempo(rawKey: string, targetWpm: number): void {
    this.tempoAssets.delete(tempoKey(rawKey, targetWpm));
  }

  putTempo(
    rawKey: string,
    targetWpm: number,
    asset: Omit<TempoReadAloudAsset, "createdAtMs" | "lastAccessedAtMs">,
  ): void {
    const now = this.now();
    this.tempoAssets.set(tempoKey(rawKey, targetWpm), {
      ...asset,
      createdAtMs: now,
      lastAccessedAtMs: now,
    });
  }

  async prune(): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const [key, asset] of this.rawAssets) {
      if (!this.isExpired(asset.lastAccessedAtMs)) continue;
      this.rawAssets.delete(key);
      removals.push(this.removePath(asset.audioPath));
    }
    for (const [key, asset] of this.tempoAssets) {
      if (!this.isExpired(asset.lastAccessedAtMs)) continue;
      this.tempoAssets.delete(key);
      removals.push(this.removePath(asset.audioPath));
    }
    await Promise.all(removals);
  }

  async disposeGeneration(generationId: string): Promise<void> {
    const removals: Promise<void>[] = [];
    for (const [key, asset] of this.rawAssets) {
      if (asset.generationId !== generationId) continue;
      this.rawAssets.delete(key);
      removals.push(this.removePath(asset.audioPath));
    }
    await Promise.all(removals);
  }

  private isExpired(lastAccessedAtMs: number): boolean {
    return this.now() - lastAccessedAtMs > this.ttlMs;
  }
}

export const readAloudAssetCache = new InMemoryReadAloudAssetCache();
