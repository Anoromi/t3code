import type { Thread } from "./types";

type ThreadMessageTimestamp = Pick<Thread["messages"][number], "createdAt" | "role">;

export function getLatestUserMessageAt(
  messages: ReadonlyArray<ThreadMessageTimestamp>,
): string | null {
  let latestUserMessageAt: string | null = null;

  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    if (latestUserMessageAt === null || message.createdAt > latestUserMessageAt) {
      latestUserMessageAt = message.createdAt;
    }
  }

  return latestUserMessageAt;
}

export function getThreadRecencyAt(thread: {
  createdAt: string;
  updatedAt?: string | undefined;
  latestUserMessageAt?: string | null;
  messages?: ReadonlyArray<ThreadMessageTimestamp>;
}): string {
  return (
    thread.latestUserMessageAt ??
    (thread.messages ? getLatestUserMessageAt(thread.messages) : null) ??
    thread.updatedAt ??
    thread.createdAt
  );
}
