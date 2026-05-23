// @effect-diagnostics nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ReadAloudTimingChunk } from "./localAiToolsSession.ts";

const execFileAsync = promisify(execFile);

export interface ReadAloudTempoInput {
  readonly rawAudioPath: string;
  readonly text: string;
  readonly audioSeconds: number | null;
  readonly wordCount: number | null;
  readonly targetWpm: number;
  readonly outputPath: string;
}

export interface ReadAloudTempoResult {
  readonly audioPath: string;
  readonly generatedWpm: number | null;
  readonly renderedWpm: number;
  readonly tempoFactor: number;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function generatedWpmFor(input: ReadAloudTempoInput): number | null {
  const wordCount = input.wordCount ?? countWords(input.text);
  if (!input.audioSeconds || !Number.isFinite(input.audioSeconds) || input.audioSeconds <= 0) {
    return null;
  }
  if (!Number.isFinite(wordCount) || wordCount <= 0) return null;
  const generatedWpm = wordCount / (input.audioSeconds / 60);
  return Number.isFinite(generatedWpm) && generatedWpm > 0 ? generatedWpm : null;
}

export function buildAtempoFilter(factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0) return "atempo=1.00000000";
  const filters: number[] = [];
  let remaining = factor;
  while (remaining > 2) {
    filters.push(2);
    remaining /= 2;
  }
  while (remaining < 0.5) {
    filters.push(0.5);
    remaining /= 0.5;
  }
  filters.push(remaining);
  return filters.map((value) => `atempo=${value.toFixed(8)}`).join(",");
}

export function scaleReadAloudTimings(
  timings: readonly ReadAloudTimingChunk[],
  tempoFactor: number,
): ReadAloudTimingChunk[] {
  if (!Number.isFinite(tempoFactor) || tempoFactor <= 0 || tempoFactor === 1) {
    return [...timings];
  }
  return timings.map((timing) => ({
    ...timing,
    start: timing.start / tempoFactor,
    end: timing.end / tempoFactor,
    duration: timing.duration / tempoFactor,
  }));
}

export async function renderReadAloudTempo(
  input: ReadAloudTempoInput,
): Promise<ReadAloudTempoResult> {
  const generatedWpm = generatedWpmFor(input);
  const tempoFactor = generatedWpm ? input.targetWpm / generatedWpm : 1;
  try {
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input.rawAudioPath,
      "-filter:a",
      buildAtempoFilter(tempoFactor),
      input.outputPath,
    ]);
  } catch (cause) {
    throw new Error("Audio tempo render failed", { cause });
  }
  return {
    audioPath: input.outputPath,
    generatedWpm,
    renderedWpm: input.targetWpm,
    tempoFactor,
  };
}
