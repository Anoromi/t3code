// @effect-diagnostics nodeBuiltinImport:off
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { LocalAiToolsSessionManager } from "./localAiToolsSession.ts";

class FakeLocalAiToolsProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly writes: unknown[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      for (const line of String(chunk).split("\n")) {
        if (line.trim().length > 0) this.writes.push(JSON.parse(line) as unknown);
      }
    });
  }

  emitJson(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed = true;
    this.signalCode = signal;
    return true;
  }
}

function createHarness() {
  const processes: FakeLocalAiToolsProcess[] = [];
  const spawnProcess = vi.fn(() => {
    const child = new FakeLocalAiToolsProcess();
    processes.push(child);
    return child as never;
  });
  const manager = new LocalAiToolsSessionManager({
    spawnProcess: spawnProcess as never,
    timeoutMs: 5_000,
  });
  return { manager, processes, spawnProcess };
}

function synthRequest(process: FakeLocalAiToolsProcess, index = 0) {
  return process.writes[index] as {
    readonly id: string;
    readonly method: string;
    readonly params: {
      readonly text: string;
      readonly voice: string;
      readonly speed: number;
      readonly target_wpm: number | null;
      readonly precision: string;
      readonly format: string;
      readonly profile_path: string | null;
      readonly output_path: string;
      readonly timings_path: string;
    };
  };
}

async function finishRequest(process: FakeLocalAiToolsProcess, index = 0): Promise<void> {
  const request = synthRequest(process, index);
  await writeFile(
    request.params.timings_path,
    JSON.stringify({
      chunks: [
        {
          index: 0,
          text: request.params.text,
          start: 0,
          end: 1,
          duration: 1,
          timing_basis: "native",
        },
      ],
    }),
  );
  process.emitJson({
    id: request.id,
    event: "finished",
    result: {
      output_path: request.params.output_path,
      timings_path: request.params.timings_path,
      audio_seconds: 1,
      word_count: 2,
      actual_wpm: 120,
    },
  });
}

async function finishRequestWithWords(process: FakeLocalAiToolsProcess, index = 0): Promise<void> {
  const request = synthRequest(process, index);
  await writeFile(
    request.params.timings_path,
    JSON.stringify({
      chunks: [
        {
          index: 0,
          text: request.params.text,
          start: 0,
          end: 1,
          duration: 1,
          timing_basis: "native",
        },
      ],
      words: [
        {
          index: 0,
          text: "Hello",
          start: 0,
          end: 0.4,
          duration: 0.4,
        },
        {
          index: 1,
          text: "world",
          start: 0.4,
          end: 1,
          duration: 0.6,
        },
      ],
    }),
  );
  process.emitJson({
    id: request.id,
    event: "finished",
    result: {
      output_path: request.params.output_path,
      timings_path: request.params.timings_path,
      audio_seconds: 1,
      word_count: 2,
      actual_wpm: 120,
    },
  });
}

describe("LocalAiToolsSessionManager", () => {
  it("waits for ready and sends valid synthesize JSON", async () => {
    const { manager, processes, spawnProcess } = createHarness();
    const promise = manager.synthesize({ text: "Hello world.", voice: "af_sarah", speed: 2 });

    expect(spawnProcess).toHaveBeenCalledWith("local-ai-tools", ["session"], expect.any(Object));
    expect(processes[0]!.writes).toHaveLength(0);

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));

    const request = synthRequest(processes[0]!);
    expect(request).toMatchObject({
      method: "synthesize",
      params: {
        text: "Hello world.",
        voice: "af_sarah",
        speed: 2,
        target_wpm: null,
        precision: "fp16",
        format: "wav",
        profile_path: null,
      },
    });
    expect(request.params.output_path).toContain("speech.wav");
    expect(request.params.timings_path).toContain("speech.json");

    await finishRequest(processes[0]!);
    await expect(promise).resolves.toMatchObject({
      audioPath: request.params.output_path,
      timingsPath: request.params.timings_path,
      audioSeconds: 1,
      wordCount: 2,
      actualWpm: 120,
      timings: [{ text: "Hello world." }],
    });
    await manager.dispose();
  });

  it("prefers word timings from the sidecar when available", async () => {
    const { manager, processes } = createHarness();
    const promise = manager.synthesize({ text: "Hello world.", voice: "af_sarah", speed: 1 });

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));

    await finishRequestWithWords(processes[0]!);
    await expect(promise).resolves.toMatchObject({
      timings: [
        { index: 0, text: "Hello", start: 0, end: 0.4, timing_basis: "native" },
        { index: 1, text: "world", start: 0.4, end: 1, timing_basis: "native" },
      ],
    });
    await manager.dispose();
  });

  it("rejects on protocol error", async () => {
    const { manager, processes } = createHarness();
    const promise = manager.synthesize({ text: "Hello.", voice: "af_sarah", speed: 1 });

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));
    processes[0]!.emitJson({
      id: synthRequest(processes[0]!).id,
      event: "error",
      error: { stage: "synthesize", message: "bad synth", detail: "" },
    });

    await expect(promise).rejects.toThrow("bad synth");
    await manager.dispose();
  });

  it("serializes concurrent requests FIFO", async () => {
    const { manager, processes } = createHarness();
    const first = manager.synthesize({ text: "First.", voice: "af_sarah", speed: 1 });
    const second = manager.synthesize({ text: "Second.", voice: "af_sarah", speed: 1.5 });

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));
    expect(synthRequest(processes[0]!, 0).params.text).toBe("First.");

    await finishRequest(processes[0]!, 0);
    await expect(first).resolves.toMatchObject({ wordCount: 2 });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(2));
    expect(synthRequest(processes[0]!, 1).params.text).toBe("Second.");

    await finishRequest(processes[0]!, 1);
    await expect(second).resolves.toMatchObject({ wordCount: 2 });
    await manager.dispose();
  });

  it("rejects active and queued requests on process exit and restarts later", async () => {
    const { manager, processes } = createHarness();
    const first = manager.synthesize({ text: "First.", voice: "af_sarah", speed: 1 });
    const second = manager.synthesize({ text: "Second.", voice: "af_sarah", speed: 1 });

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));
    processes[0]!.emit("exit", 1, null);

    await expect(first).rejects.toThrow("local-ai-tools session exited");
    await expect(second).rejects.toThrow("local-ai-tools session exited");

    const third = manager.synthesize({ text: "Third.", voice: "af_sarah", speed: 2 });
    processes[1]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[1]!.writes).toHaveLength(1));
    await finishRequest(processes[1]!, 0);
    await expect(third).resolves.toMatchObject({ wordCount: 2 });
    await manager.dispose();
  });

  it("sends exit on dispose", async () => {
    const { manager, processes } = createHarness();
    const promise = manager.synthesize({ text: "Hello.", voice: "af_sarah", speed: 1 });
    promise.catch(() => undefined);
    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));
    await manager.dispose();

    await expect(promise).rejects.toThrow("Local AI Tools session disposed");
    expect(processes[0]!.writes.at(-1)).toMatchObject({
      method: "exit",
      params: {},
    });
  });

  it("prewarms the session without sending synthesize", async () => {
    const { manager, processes, spawnProcess } = createHarness();
    const promise = manager.prewarm();

    expect(spawnProcess).toHaveBeenCalledWith("local-ai-tools", ["session"], expect.any(Object));
    expect(processes[0]!.writes).toHaveLength(0);

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });

    await expect(promise).resolves.toBeUndefined();
    expect(processes[0]!.writes).toHaveLength(0);
    await manager.dispose();
  });

  it("warms up the synthesis path with one tiny request", async () => {
    const { manager, processes, spawnProcess } = createHarness();
    const promise = manager.warmup();

    expect(spawnProcess).toHaveBeenCalledWith("local-ai-tools", ["session"], expect.any(Object));
    expect(processes[0]!.writes).toHaveLength(0);

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));

    const request = synthRequest(processes[0]!);
    expect(request).toMatchObject({
      method: "synthesize",
      params: {
        text: "Ready.",
        voice: "af_sarah",
        speed: 1,
        precision: "fp16",
      },
    });

    await finishRequest(processes[0]!);
    await expect(promise).resolves.toBeUndefined();
    await manager.dispose();
  });

  it("deduplicates concurrent synthesis warmups", async () => {
    const { manager, processes } = createHarness();
    const first = manager.warmup();
    const second = manager.warmup();

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));

    await finishRequest(processes[0]!);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(processes[0]!.writes).toHaveLength(1);
    await manager.dispose();
  });

  it("does not repeat synthesis warmup after it succeeds", async () => {
    const { manager, processes } = createHarness();
    const first = manager.warmup();

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));
    await finishRequest(processes[0]!);
    await first;

    await expect(manager.warmup()).resolves.toBeUndefined();
    expect(processes[0]!.writes).toHaveLength(1);
    await manager.dispose();
  });

  it("warmup failure does not poison later synthesize", async () => {
    const { manager, processes, spawnProcess } = createHarness();
    const warmup = manager.warmup();

    processes[0]!.emit("exit", 1, null);
    await expect(warmup).rejects.toThrow("local-ai-tools session exited");

    const synthesize = manager.synthesize({ text: "Hello.", voice: "af_sarah", speed: 1 });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    processes[1]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[1]!.writes).toHaveLength(1));

    await finishRequest(processes[1]!);
    await expect(synthesize).resolves.toMatchObject({ wordCount: 2 });
    await manager.dispose();
  });

  it("synthesize joins an in-flight prewarm", async () => {
    const { manager, processes, spawnProcess } = createHarness();
    const prewarm = manager.prewarm();
    const synthesize = manager.synthesize({ text: "Hello.", voice: "af_sarah", speed: 1 });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(processes[0]!.writes).toHaveLength(0);

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await prewarm;
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));

    await finishRequest(processes[0]!);
    await expect(synthesize).resolves.toMatchObject({ wordCount: 2 });
    await manager.dispose();
  });

  it("prewarm failure does not poison later synthesize", async () => {
    const { manager, processes, spawnProcess } = createHarness();
    const prewarm = manager.prewarm();

    processes[0]!.emit("exit", 1, null);
    await expect(prewarm).rejects.toThrow("local-ai-tools session exited");

    const synthesize = manager.synthesize({ text: "Hello.", voice: "af_sarah", speed: 1 });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    processes[1]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[1]!.writes).toHaveLength(1));

    await finishRequest(processes[1]!);
    await expect(synthesize).resolves.toMatchObject({ wordCount: 2 });
    await manager.dispose();
  });

  it("decodes daemon lifecycle events before finishing synthesis", async () => {
    const { manager, processes } = createHarness();
    const promise = manager.synthesize({ text: "Hello.", voice: "af_sarah", speed: 1 });

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));
    const request = synthRequest(processes[0]!);
    processes[0]!.emitJson({ id: request.id, event: "daemon_starting" });
    processes[0]!.emitJson({ id: request.id, event: "daemon_ready", pid: 123 });
    processes[0]!.emitJson({ id: request.id, event: "started" });

    await finishRequest(processes[0]!);
    await expect(promise).resolves.toMatchObject({ wordCount: 2 });
    await manager.dispose();
  });

  it("malformed protocol JSON cleans up and allows retry", async () => {
    const { manager, processes, spawnProcess } = createHarness();
    const first = manager.synthesize({ text: "First.", voice: "af_sarah", speed: 1 });

    processes[0]!.stdout.write("{not json}\n");
    await expect(first).rejects.toThrow("Local AI Tools session emitted malformed JSON");

    const second = manager.synthesize({ text: "Second.", voice: "af_sarah", speed: 1 });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    processes[1]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[1]!.writes).toHaveLength(1));

    await finishRequest(processes[1]!);
    await expect(second).resolves.toMatchObject({ wordCount: 2 });
    await manager.dispose();
  });

  it("schema-invalid protocol JSON cleans up and allows retry", async () => {
    const { manager, processes, spawnProcess } = createHarness();
    const first = manager.synthesize({ text: "First.", voice: "af_sarah", speed: 1 });

    processes[0]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[0]!.writes).toHaveLength(1));
    processes[0]!.emitJson({ id: synthRequest(processes[0]!).id, event: "unexpected" });

    await expect(first).rejects.toThrow("Local AI Tools session emitted malformed JSON");

    const second = manager.synthesize({ text: "Second.", voice: "af_sarah", speed: 1 });
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    processes[1]!.emitJson({ event: "ready", version: "0.3.0" });
    await vi.waitFor(() => expect(processes[1]!.writes).toHaveLength(1));

    await finishRequest(processes[1]!);
    await expect(second).resolves.toMatchObject({ wordCount: 2 });
    await manager.dispose();
  });
});
