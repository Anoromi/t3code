// @effect-diagnostics nodeBuiltinImport:off importFromBarrel:off globalTimers:off globalConsole:off
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import {
  SessionEvent as SessionEventSchema,
  requestLine,
  type SessionEvent,
  type SynthesizeParams,
} from "@anoromi/local-ai-tools-protocol";
import { Schema } from "effect";

const READ_ALOUD_LOCAL_AI_TOOLS_PRECISION = "fp16" satisfies SynthesizeParams["precision"];
const READ_ALOUD_LOCAL_AI_TOOLS_TARGET_WPM = null;
const READ_ALOUD_LOCAL_AI_TOOLS_FORMAT = "wav";
const READ_ALOUD_LOCAL_AI_TOOLS_WARMUP_TEXT = "Ready.";
const READ_ALOUD_LOCAL_AI_TOOLS_WARMUP_VOICE = "af_sarah";

export interface ReadAloudTimingChunk {
  readonly index: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly duration: number;
  readonly timing_basis: string;
}

export interface LocalAiToolsSynthesizeInput {
  readonly text: string;
  readonly voice: string;
  readonly speed: 1 | 1.5 | 2;
}

export interface LocalAiToolsSynthesizeResult {
  readonly audioPath: string;
  readonly timingsPath: string;
  readonly audioSeconds: number | null;
  readonly wordCount: number | null;
  readonly actualWpm: number | null;
  readonly timings: ReadAloudTimingChunk[];
}

export interface LocalAiToolsSession {
  prewarm(): Promise<void>;
  warmup(input?: { readonly voice?: string }): Promise<void>;
  synthesize(input: LocalAiToolsSynthesizeInput): Promise<LocalAiToolsSynthesizeResult>;
  dispose(): Promise<void>;
}

interface LocalAiToolsSessionOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
  readonly now?: () => number;
  readonly logTiming?: (message: string) => void;
}

interface QueuedRequest {
  readonly input: LocalAiToolsSynthesizeInput;
  readonly resolve: (result: LocalAiToolsSynthesizeResult) => void;
  readonly reject: (error: Error) => void;
  readonly enqueuedAt: number;
  readonly cleanupTempDirOnSuccess: boolean;
}

interface ActiveRequest extends QueuedRequest {
  readonly id: string;
  readonly tempDir: string;
  readonly outputPath: string;
  readonly timingsPath: string;
  readonly startedAt: number;
  timeout: ReturnType<typeof setTimeout> | null;
}

function isReadAloudTimingChunk(value: unknown): value is ReadAloudTimingChunk {
  if (!value || typeof value !== "object") return false;
  const chunk = value as Record<string, unknown>;
  return (
    typeof chunk.index === "number" &&
    typeof chunk.text === "string" &&
    typeof chunk.start === "number" &&
    typeof chunk.end === "number" &&
    typeof chunk.duration === "number" &&
    typeof chunk.timing_basis === "string"
  );
}

function readTimingChunks(timingsDocument: {
  readonly chunks?: unknown[];
  readonly words?: unknown[];
}) {
  const words = Array.isArray(timingsDocument.words)
    ? timingsDocument.words
        .map((value): ReadAloudTimingChunk | null => {
          if (!value || typeof value !== "object") return null;
          const word = value as Record<string, unknown>;
          return typeof word.index === "number" &&
            typeof word.text === "string" &&
            typeof word.start === "number" &&
            typeof word.end === "number" &&
            typeof word.duration === "number"
            ? {
                index: word.index,
                text: word.text,
                start: word.start,
                end: word.end,
                duration: word.duration,
                timing_basis: typeof word.timing_basis === "string" ? word.timing_basis : "native",
              }
            : null;
        })
        .filter((chunk): chunk is ReadAloudTimingChunk => chunk !== null)
    : [];
  if (words.length > 0) return words;
  return Array.isArray(timingsDocument.chunks)
    ? timingsDocument.chunks.filter(isReadAloudTimingChunk)
    : [];
}

function errorMessageForEvent(event: Extract<SessionEvent, { event: "error" }>): string {
  return event.error.message || event.error.detail || "Local AI Tools failed to start";
}

function numberResultField(result: Record<string, unknown>, key: string): number | null {
  const value = result[key];
  return typeof value === "number" ? value : null;
}

function stringResultField(result: Record<string, unknown>, key: string, fallback: string): string {
  const value = result[key];
  return typeof value === "string" ? value : fallback;
}

export class LocalAiToolsSessionManager implements LocalAiToolsSession {
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;
  private readonly spawnProcess: typeof spawn;
  private readonly now: () => number;
  private readonly logTiming: (message: string) => void;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private active: ActiveRequest | null = null;
  private queue: QueuedRequest[] = [];
  private pumping = false;
  private nextRequestId = 1;
  private disposed = false;
  private warmupPromise: Promise<void> | null = null;
  private warmupCompleted = false;

  constructor(options: LocalAiToolsSessionOptions = {}) {
    this.command = options.command ?? "local-ai-tools";
    this.args = options.args ?? ["session"];
    this.timeoutMs = options.timeoutMs ?? 3_600_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.now = options.now ?? (() => performance.now());
    this.logTiming = options.logTiming ?? (() => undefined);
  }

  prewarm(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Local AI Tools session is disposed"));
    this.logTiming("local-ai-tools prewarm started");
    return this.ensureStarted().then(
      () => {
        this.logTiming("local-ai-tools prewarm ready");
      },
      (cause) => {
        this.logTiming(
          `local-ai-tools prewarm failed ${cause instanceof Error ? cause.message : String(cause)}`,
        );
        throw cause;
      },
    );
  }

  warmup(input: { readonly voice?: string } = {}): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Local AI Tools session is disposed"));
    if (this.warmupCompleted) return Promise.resolve();
    if (this.warmupPromise) return this.warmupPromise;

    const voice = input.voice ?? READ_ALOUD_LOCAL_AI_TOOLS_WARMUP_VOICE;
    this.logTiming("local-ai-tools warmup synthesis started");
    this.warmupPromise = this.synthesizeInternal(
      {
        text: READ_ALOUD_LOCAL_AI_TOOLS_WARMUP_TEXT,
        voice,
        speed: 1,
      },
      { cleanupTempDirOnSuccess: true },
    ).then(
      () => {
        this.warmupCompleted = true;
        this.logTiming("local-ai-tools warmup synthesis ready");
      },
      (cause) => {
        this.logTiming(
          `local-ai-tools warmup synthesis failed ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
        throw cause;
      },
    );
    this.warmupPromise
      .finally(() => {
        this.warmupPromise = null;
      })
      .catch(() => undefined);
    return this.warmupPromise;
  }

  synthesize(input: LocalAiToolsSynthesizeInput): Promise<LocalAiToolsSynthesizeResult> {
    if (this.disposed) return Promise.reject(new Error("Local AI Tools session is disposed"));
    return this.synthesizeInternal(input);
  }

  private synthesizeInternal(
    input: LocalAiToolsSynthesizeInput,
    options: { readonly cleanupTempDirOnSuccess?: boolean } = {},
  ): Promise<LocalAiToolsSynthesizeResult> {
    return new Promise<LocalAiToolsSynthesizeResult>((resolve, reject) => {
      this.queue.push({
        input,
        resolve,
        reject,
        enqueuedAt: this.now(),
        cleanupTempDirOnSuccess: options.cleanupTempDirOnSuccess ?? false,
      });
      void this.pump();
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const child = this.child;
    this.rejectReady(new Error("Local AI Tools session disposed"));
    this.rejectActiveAndQueued(new Error("Local AI Tools session disposed"));
    if (child && !child.killed && child.stdin.writable) {
      child.stdin.write(requestLine(`exit-${this.nextRequestId++}`, "exit", {}));
    }
    await new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        resolve();
      }, 500);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.cleanupProcess();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.active && this.queue.length > 0 && !this.disposed) {
        const request = this.queue.shift();
        if (!request) return;
        try {
          await this.ensureStarted();
          await this.startRequest(request);
        } catch (cause) {
          request.reject(
            cause instanceof Error ? cause : new Error("Local AI Tools failed to start"),
          );
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      const child = this.spawnProcess(this.command, this.args, {
        stdio: "pipe",
        shell: process.platform === "win32",
      }) as ChildProcessWithoutNullStreams;
      this.child = child;
      this.lines = createInterface({ input: child.stdout });
      this.lines.on("line", (line) => this.handleLine(line));
      child.stderr.on("data", (chunk: Buffer | string) => {
        const message = String(chunk).trim();
        if (message.length > 0) this.logTiming(`local-ai-tools stderr: ${message}`);
      });
      child.once("error", (error) => this.handleExit(this.normalizeProcessError(error)));
      child.once("exit", (code, signal) => {
        this.handleExit(
          new Error(`local-ai-tools session exited (code=${code}, signal=${signal})`),
        );
      });
    });
    return this.readyPromise;
  }

  private async startRequest(request: QueuedRequest): Promise<void> {
    const child = this.child;
    if (!child || !child.stdin.writable) throw new Error("Local AI Tools failed to start");
    const tempDir = await mkdtemp(join(tmpdir(), "t3code-read-aloud-"));
    const active: ActiveRequest = {
      ...request,
      id: `read-aloud-${this.nextRequestId++}`,
      tempDir,
      outputPath: join(tempDir, "speech.wav"),
      timingsPath: join(tempDir, "speech.json"),
      startedAt: this.now(),
      timeout: null,
    };
    this.active = active;
    active.timeout = setTimeout(() => {
      this.failActive(new Error("Local AI Tools synthesis timed out"));
      this.restartAfterFailure();
    }, this.timeoutMs);
    this.logTiming(
      `local-ai-tools queue wait ${(active.startedAt - active.enqueuedAt).toFixed(1)}ms for ${active.id}`,
    );
    const params: SynthesizeParams = {
      text: active.input.text,
      voice: active.input.voice,
      speed: active.input.speed,
      target_wpm: READ_ALOUD_LOCAL_AI_TOOLS_TARGET_WPM,
      precision: READ_ALOUD_LOCAL_AI_TOOLS_PRECISION,
      format: READ_ALOUD_LOCAL_AI_TOOLS_FORMAT,
      profile_path: null,
      output_path: active.outputPath,
      timings_path: active.timingsPath,
    };
    child.stdin.write(requestLine(active.id, "synthesize", params));
  }

  private handleLine(line: string): void {
    let event: SessionEvent;
    try {
      event = Schema.decodeUnknownSync(SessionEventSchema)(JSON.parse(line) as unknown);
    } catch {
      this.handleExit(new Error("Local AI Tools session emitted malformed JSON"));
      return;
    }

    if (event.event === "ready") {
      this.readyResolve?.();
      this.readyResolve = null;
      this.readyReject = null;
      this.logTiming(`local-ai-tools session ready version=${event.version}`);
      return;
    }

    if (event.event === "error") {
      const error = new Error(errorMessageForEvent(event));
      if (event.id && this.active?.id === event.id) {
        this.failActive(error);
        void this.pump();
        return;
      }
      this.rejectReady(error);
      this.cleanupProcess();
      return;
    }

    const active = this.active;
    if (!active || event.id !== active.id) return;
    if (event.event === "accepted") {
      this.logTiming(`local-ai-tools request accepted ${active.id}`);
      return;
    }
    if (event.event === "daemon_starting") {
      this.logTiming(`local-ai-tools daemon starting ${active.id}`);
      return;
    }
    if (event.event === "daemon_ready") {
      this.logTiming(`local-ai-tools daemon ready ${active.id} pid=${event.pid}`);
      return;
    }
    if (event.event === "started") {
      this.logTiming(`local-ai-tools request started ${active.id}`);
      return;
    }
    if (event.event === "chunk") {
      this.logTiming(`local-ai-tools first chunk ${active.id}`);
      return;
    }
    if (event.event === "finished") {
      void this.finishActive(active, event);
      return;
    }
    if (event.event === "health") return;
  }

  private async finishActive(
    active: ActiveRequest,
    event: Extract<SessionEvent, { event: "finished" }>,
  ): Promise<void> {
    if (active.timeout) clearTimeout(active.timeout);
    this.active = null;
    try {
      const timingsBytes = await readFile(active.timingsPath);
      const timingsDocument = JSON.parse(timingsBytes.toString("utf8")) as {
        chunks?: unknown[];
        words?: unknown[];
      };
      this.logTiming(
        `local-ai-tools request finished ${active.id} in ${(this.now() - active.startedAt).toFixed(1)}ms`,
      );
      active.resolve({
        audioPath: stringResultField(event.result, "output_path", active.outputPath),
        timingsPath: stringResultField(event.result, "timings_path", active.timingsPath),
        audioSeconds: numberResultField(event.result, "audio_seconds"),
        wordCount: numberResultField(event.result, "word_count"),
        actualWpm: numberResultField(event.result, "actual_wpm"),
        timings: readTimingChunks(timingsDocument),
      });
      if (active.cleanupTempDirOnSuccess) {
        await rm(active.tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    } catch (cause) {
      active.reject(
        cause instanceof Error ? cause : new Error("Local AI Tools timing parse failed"),
      );
      await rm(active.tempDir, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      void this.pump();
    }
  }

  private failActive(error: Error): void {
    const active = this.active;
    if (!active) return;
    if (active.timeout) clearTimeout(active.timeout);
    this.active = null;
    active.reject(error);
    void rm(active.tempDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private rejectActiveAndQueued(error: Error): void {
    this.failActive(error);
    const queued = this.queue.splice(0);
    for (const request of queued) request.reject(error);
  }

  private rejectReady(error: Error): void {
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
  }

  private handleExit(error: Error): void {
    this.rejectReady(error);
    this.rejectActiveAndQueued(error);
    this.cleanupProcess();
  }

  private normalizeProcessError(error: Error): Error {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new Error("Local AI Tools failed to start");
    }
    return error;
  }

  private restartAfterFailure(): void {
    this.cleanupProcess();
    void this.pump();
  }

  private cleanupProcess(): void {
    this.lines?.close();
    this.lines = null;
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
    this.child = null;
    this.readyPromise = null;
    this.readyResolve = null;
    this.readyReject = null;
  }
}

export const readAloudLocalAiToolsSession = new LocalAiToolsSessionManager({
  logTiming: (message) => {
    if (process.env.NODE_ENV !== "production") {
      console.debug(`[read-aloud local-ai-tools] ${message}`);
    }
  },
});
