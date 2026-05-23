import { describe, expect, it, vi } from "vitest";

import { createAudioPlaybackHandle } from "./audioPlayback";

type FakeAudioEvent = "loadedmetadata" | "error" | "ended";

class FakeAudioElement {
  currentTime = 0;
  duration = 0;
  load = vi.fn();
  pause = vi.fn();
  play = vi.fn(async () => undefined);
  playbackRate = 1;
  preload = "";
  preservesPitch = false;
  mozPreservesPitch = false;
  webkitPreservesPitch = false;
  src: string;
  readonly listeners = new Map<FakeAudioEvent, Set<() => void>>();

  constructor(src: string) {
    this.src = src;
  }

  addEventListener(event: FakeAudioEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeEventListener(event: FakeAudioEvent, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: FakeAudioEvent): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener();
    }
  }

  listenerCount(event: FakeAudioEvent): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

function createHarness() {
  const created: FakeAudioElement[] = [];
  const handle = createAudioPlaybackHandle({
    createAudio: (audioUrl) => {
      const audio = new FakeAudioElement(audioUrl);
      created.push(audio);
      return audio as never;
    },
  });
  return { created, handle };
}

describe("createAudioPlaybackHandle", () => {
  it("waits for metadata before resolving load", async () => {
    const { created, handle } = createHarness();
    let resolved = false;

    const loadPromise = handle.load({ audioUrl: "/audio.wav" }).then(() => {
      resolved = true;
    });

    expect(created).toHaveLength(1);
    await Promise.resolve();
    expect(resolved).toBe(false);

    created[0]!.duration = 20;
    created[0]!.emit("loadedmetadata");
    await loadPromise;

    expect(resolved).toBe(true);
    expect(handle.snapshot().status).toBe("ready");
  });

  it("uses native playback rate without WPM correction", async () => {
    const { created, handle } = createHarness();
    const loadPromise = handle.load({ audioUrl: "/audio.wav" });

    created[0]!.duration = 30;
    created[0]!.emit("loadedmetadata");

    const snapshot = await loadPromise;
    expect(created[0]!.playbackRate).toBe(1);
    expect(snapshot.generatedWpm).toBe(null);
    expect(snapshot.playbackRate).toBe(1);
  });

  it("sets pitch preservation fields", async () => {
    const { created, handle } = createHarness();
    const loadPromise = handle.load({ audioUrl: "/audio.wav" });

    created[0]!.duration = 30;
    created[0]!.emit("loadedmetadata");
    await loadPromise;

    expect(created[0]!.preload).toBe("auto");
    expect(created[0]!.preservesPitch).toBe(true);
    expect(created[0]!.mozPreservesPitch).toBe(true);
    expect(created[0]!.webkitPreservesPitch).toBe(true);
  });

  it("transitions when playing, pausing, and stopping", async () => {
    const { created, handle } = createHarness();
    const loadPromise = handle.load({ audioUrl: "/audio.wav" });

    created[0]!.duration = 30;
    created[0]!.emit("loadedmetadata");
    await loadPromise;

    expect((await handle.play()).status).toBe("playing");
    expect(created[0]!.play).toHaveBeenCalledTimes(1);

    expect(handle.pause().status).toBe("paused");
    expect(created[0]!.pause).toHaveBeenCalledTimes(1);

    created[0]!.currentTime = 12;
    expect(handle.stop().status).toBe("ready");
    expect(created[0]!.currentTime).toBe(0);
  });

  it("tracks seek snapshots", async () => {
    const { created, handle } = createHarness();
    const loadPromise = handle.load({ audioUrl: "/audio.wav" });

    created[0]!.duration = 30;
    created[0]!.emit("loadedmetadata");
    await loadPromise;

    expect(handle.seek(12).currentTimeSeconds).toBe(12);
    expect(handle.seek(-1).currentTimeSeconds).toBe(0);
    expect(handle.seek(99).currentTimeSeconds).toBe(30);
  });

  it("updates status on ended and error events", async () => {
    const { created, handle } = createHarness();
    const ended = vi.fn();
    const error = vi.fn();
    handle.on("ended", ended);
    handle.on("error", error);

    const loadPromise = handle.load({ audioUrl: "/audio.wav" });
    created[0]!.duration = 30;
    created[0]!.emit("loadedmetadata");
    await loadPromise;

    created[0]!.emit("ended");
    expect(handle.snapshot().status).toBe("ended");
    expect(ended).toHaveBeenCalledTimes(1);

    created[0]!.emit("error");
    expect(handle.snapshot().status).toBe("error");
    expect(handle.snapshot().errorMessage).toBe("Audio playback failed");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("reports play errors", async () => {
    const { created, handle } = createHarness();
    const error = vi.fn();
    handle.on("error", error);

    const loadPromise = handle.load({ audioUrl: "/audio.wav" });
    created[0]!.duration = 30;
    created[0]!.emit("loadedmetadata");
    await loadPromise;
    created[0]!.play.mockRejectedValueOnce(new Error("blocked"));

    await expect(handle.play()).rejects.toThrow("blocked");
    expect(handle.snapshot().status).toBe("error");
    expect(handle.snapshot().errorMessage).toBe("blocked");
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("disposes listeners and clears audio", async () => {
    const { created, handle } = createHarness();
    const loadPromise = handle.load({ audioUrl: "/audio.wav" });

    created[0]!.duration = 30;
    created[0]!.emit("loadedmetadata");
    await loadPromise;

    expect(created[0]!.listenerCount("ended")).toBe(1);
    expect(created[0]!.listenerCount("error")).toBe(1);

    handle.dispose();

    expect(created[0]!.pause).toHaveBeenCalledTimes(1);
    expect(created[0]!.src).toBe("");
    expect(created[0]!.load).toHaveBeenCalledTimes(2);
    expect(created[0]!.listenerCount("ended")).toBe(0);
    expect(created[0]!.listenerCount("error")).toBe(0);
    expect(handle.snapshot().status).toBe("idle");
  });
});
