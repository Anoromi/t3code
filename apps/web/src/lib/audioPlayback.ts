export interface AudioPlaybackLoadInput {
  readonly audioUrl: string;
}

export type AudioPlaybackStatus =
  | "idle"
  | "loading"
  | "ready"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export interface AudioPlaybackSnapshot {
  readonly status: AudioPlaybackStatus;
  readonly durationSeconds: number | null;
  readonly currentTimeSeconds: number;
  readonly playbackRate: 1;
  readonly generatedWpm: null;
  readonly errorMessage: string | null;
}

export type AudioPlaybackEvent = "play" | "pause" | "stop" | "ended" | "error" | "loaded";

export interface AudioPlaybackHandle {
  load(input: AudioPlaybackLoadInput): Promise<AudioPlaybackSnapshot>;
  play(): Promise<AudioPlaybackSnapshot>;
  pause(): AudioPlaybackSnapshot;
  stop(): AudioPlaybackSnapshot;
  seek(seconds: number): AudioPlaybackSnapshot;
  dispose(): void;
  snapshot(): AudioPlaybackSnapshot;
  on(event: AudioPlaybackEvent, listener: () => void): () => void;
}

type ManagedAudioElement = Pick<
  HTMLAudioElement,
  | "addEventListener"
  | "currentTime"
  | "duration"
  | "load"
  | "pause"
  | "play"
  | "playbackRate"
  | "preload"
  | "removeEventListener"
  | "src"
> & {
  preservesPitch?: boolean;
  mozPreservesPitch?: boolean;
  webkitPreservesPitch?: boolean;
};

type AudioFactory = (audioUrl: string) => ManagedAudioElement;

const DEFAULT_PLAYBACK_RATE = 1;

export function createAudioPlaybackHandle(options?: {
  readonly createAudio?: AudioFactory;
}): AudioPlaybackHandle {
  return new NativeAudioPlaybackHandle(options?.createAudio ?? ((audioUrl) => new Audio(audioUrl)));
}

function safeDurationSeconds(audio: ManagedAudioElement | null): number | null {
  if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) {
    return null;
  }
  return audio.duration;
}

class NativeAudioPlaybackHandle implements AudioPlaybackHandle {
  private audio: ManagedAudioElement | null = null;
  private status: AudioPlaybackStatus = "idle";
  private errorMessage: string | null = null;
  private listeners = new Map<AudioPlaybackEvent, Set<() => void>>();
  private removeAudioListeners: (() => void) | null = null;

  constructor(private readonly createAudio: AudioFactory) {}

  async load(input: AudioPlaybackLoadInput): Promise<AudioPlaybackSnapshot> {
    this.disposeAudio();
    this.status = "loading";
    this.errorMessage = null;

    const audio = this.createAudio(input.audioUrl);
    this.audio = audio;
    audio.preload = "auto";
    audio.preservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.webkitPreservesPitch = true;
    audio.playbackRate = DEFAULT_PLAYBACK_RATE;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        audio.removeEventListener("loadedmetadata", handleLoadedMetadata);
        audio.removeEventListener("error", handleError);
      };
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const handleLoadedMetadata = () => finish(resolve);
      const handleError = () => finish(() => reject(new Error("Audio failed to load")));

      audio.addEventListener("loadedmetadata", handleLoadedMetadata, { once: true });
      audio.addEventListener("error", handleError, { once: true });
      try {
        audio.load();
      } catch {
        // Some test doubles and older media implementations may not need an
        // explicit load call after src assignment. The metadata/error events
        // remain the source of truth.
      }
    }).catch((error) => {
      this.status = "error";
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.emit("error");
      throw error;
    });

    this.removeAudioListeners = this.attachAudioListeners(audio);
    this.status = "ready";
    this.emit("loaded");
    return this.snapshot();
  }

  async play(): Promise<AudioPlaybackSnapshot> {
    if (!this.audio) return this.snapshot();
    try {
      await this.audio.play();
      this.status = "playing";
      this.errorMessage = null;
      this.emit("play");
    } catch (error) {
      this.status = "error";
      this.errorMessage = error instanceof Error ? error.message : String(error);
      this.emit("error");
      throw error;
    }
    return this.snapshot();
  }

  pause(): AudioPlaybackSnapshot {
    if (!this.audio) return this.snapshot();
    this.audio.pause();
    this.status = "paused";
    this.emit("pause");
    return this.snapshot();
  }

  stop(): AudioPlaybackSnapshot {
    if (!this.audio) return this.snapshot();
    this.audio.pause();
    this.audio.currentTime = 0;
    this.status = "ready";
    this.emit("stop");
    return this.snapshot();
  }

  seek(seconds: number): AudioPlaybackSnapshot {
    if (!this.audio) return this.snapshot();
    const durationSeconds = safeDurationSeconds(this.audio);
    const maxSeconds = durationSeconds ?? Number.POSITIVE_INFINITY;
    this.audio.currentTime = Math.min(maxSeconds, Math.max(0, seconds));
    return this.snapshot();
  }

  dispose(): void {
    this.disposeAudio();
    this.status = "idle";
    this.errorMessage = null;
  }

  snapshot(): AudioPlaybackSnapshot {
    return {
      status: this.status,
      durationSeconds: safeDurationSeconds(this.audio),
      currentTimeSeconds: this.audio?.currentTime ?? 0,
      playbackRate: DEFAULT_PLAYBACK_RATE,
      generatedWpm: null,
      errorMessage: this.errorMessage,
    };
  }

  on(event: AudioPlaybackEvent, listener: () => void): () => void {
    const eventListeners = this.listeners.get(event) ?? new Set<() => void>();
    eventListeners.add(listener);
    this.listeners.set(event, eventListeners);
    return () => {
      eventListeners.delete(listener);
      if (eventListeners.size === 0) {
        this.listeners.delete(event);
      }
    };
  }

  private attachAudioListeners(audio: ManagedAudioElement): () => void {
    const handleEnded = () => {
      this.status = "ended";
      this.emit("ended");
    };
    const handleError = () => {
      this.status = "error";
      this.errorMessage = "Audio playback failed";
      this.emit("error");
    };

    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("error", handleError);

    return () => {
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("error", handleError);
    };
  }

  private disposeAudio(): void {
    this.removeAudioListeners?.();
    this.removeAudioListeners = null;

    const audio = this.audio;
    this.audio = null;
    if (!audio) return;

    try {
      audio.pause();
    } catch {
      // best effort
    }
    audio.src = "";
    try {
      audio.load();
    } catch {
      // best effort
    }
  }

  private emit(event: AudioPlaybackEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }
}
