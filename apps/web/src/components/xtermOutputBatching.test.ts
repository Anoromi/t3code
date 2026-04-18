import { describe, expect, it } from "vitest";

import {
  clearXtermOutputBatchQueue,
  createXtermOutputBatchQueue,
  enqueueXtermOutputBatchChunk,
  hasQueuedXtermOutput,
  takeNextXtermOutputBatch,
} from "./xtermOutputBatching";

describe("xtermOutputBatching", () => {
  it("combines multiple queued output chunks into one batch when under the cap", () => {
    const queue = createXtermOutputBatchQueue();
    enqueueXtermOutputBatchChunk(queue, "one");
    enqueueXtermOutputBatchChunk(queue, "two");
    enqueueXtermOutputBatchChunk(queue, "three");

    expect(takeNextXtermOutputBatch(queue, 32)).toBe("onetwothree");
    expect(hasQueuedXtermOutput(queue)).toBe(false);
    expect(takeNextXtermOutputBatch(queue, 32)).toBeNull();
  });

  it("splits a large queued chunk across capped batches", () => {
    const queue = createXtermOutputBatchQueue();
    enqueueXtermOutputBatchChunk(queue, "abcdefgh");

    expect(takeNextXtermOutputBatch(queue, 3)).toBe("abc");
    expect(takeNextXtermOutputBatch(queue, 3)).toBe("def");
    expect(takeNextXtermOutputBatch(queue, 3)).toBe("gh");
    expect(hasQueuedXtermOutput(queue)).toBe(false);
  });

  it("clears queued output state", () => {
    const queue = createXtermOutputBatchQueue();
    enqueueXtermOutputBatchChunk(queue, "queued");
    expect(hasQueuedXtermOutput(queue)).toBe(true);

    clearXtermOutputBatchQueue(queue);

    expect(hasQueuedXtermOutput(queue)).toBe(false);
    expect(takeNextXtermOutputBatch(queue, 16)).toBeNull();
  });
});
