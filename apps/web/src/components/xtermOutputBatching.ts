export const MAX_XTERM_WRITE_BATCH_CHARS = 65_536;
export const XTERM_OUTPUT_FLUSH_TIMEOUT_MS = 8;

export interface XtermOutputBatchQueue {
  chunks: string[];
  totalChars: number;
}

export function createXtermOutputBatchQueue(): XtermOutputBatchQueue {
  return {
    chunks: [],
    totalChars: 0,
  };
}

export function clearXtermOutputBatchQueue(queue: XtermOutputBatchQueue): void {
  queue.chunks.length = 0;
  queue.totalChars = 0;
}

export function enqueueXtermOutputBatchChunk(queue: XtermOutputBatchQueue, chunk: string): void {
  if (chunk.length === 0) {
    return;
  }
  queue.chunks.push(chunk);
  queue.totalChars += chunk.length;
}

export function hasQueuedXtermOutput(queue: XtermOutputBatchQueue): boolean {
  return queue.totalChars > 0;
}

export function takeNextXtermOutputBatch(
  queue: XtermOutputBatchQueue,
  maxChars: number = MAX_XTERM_WRITE_BATCH_CHARS,
): string | null {
  if (queue.totalChars === 0 || maxChars <= 0) {
    return null;
  }

  let remainingChars = maxChars;
  let nextBatch = "";
  while (remainingChars > 0 && queue.chunks.length > 0) {
    const chunk = queue.chunks[0];
    if (chunk === undefined) {
      break;
    }
    if (chunk.length <= remainingChars) {
      nextBatch += chunk;
      remainingChars -= chunk.length;
      queue.totalChars -= chunk.length;
      queue.chunks.shift();
      continue;
    }

    nextBatch += chunk.slice(0, remainingChars);
    queue.chunks[0] = chunk.slice(remainingChars);
    queue.totalChars -= remainingChars;
    remainingChars = 0;
  }

  return nextBatch.length > 0 ? nextBatch : null;
}
