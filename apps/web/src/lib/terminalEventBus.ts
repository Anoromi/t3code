import { ThreadId, type TerminalEvent } from "@t3tools/contracts";

type TerminalEventListener = (event: TerminalEvent) => void;

export interface TerminalEventBus {
  publish(event: TerminalEvent): void;
  subscribe(threadId: ThreadId, terminalId: string, listener: TerminalEventListener): () => void;
}

function terminalEventBusKey(threadId: ThreadId, terminalId: string): string {
  return `${threadId}\u0000${terminalId}`;
}

function createTerminalEventBus(): TerminalEventBus {
  const listenersByKey = new Map<string, Set<TerminalEventListener>>();

  return {
    publish(event) {
      const listeners = listenersByKey.get(
        terminalEventBusKey(ThreadId.make(event.threadId), event.terminalId),
      );
      if (!listeners || listeners.size === 0) {
        return;
      }

      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // Keep the event bus alive even if one subscriber throws.
        }
      }
    },
    subscribe(threadId, terminalId, listener) {
      const key = terminalEventBusKey(threadId, terminalId);
      const existing = listenersByKey.get(key);
      if (existing) {
        existing.add(listener);
      } else {
        listenersByKey.set(key, new Set([listener]));
      }

      return () => {
        const listeners = listenersByKey.get(key);
        if (!listeners) {
          return;
        }
        listeners.delete(listener);
        if (listeners.size === 0) {
          listenersByKey.delete(key);
        }
      };
    },
  };
}

let sharedTerminalEventBus: TerminalEventBus | null = null;

export function getTerminalEventBus(): TerminalEventBus {
  if (sharedTerminalEventBus) {
    return sharedTerminalEventBus;
  }
  sharedTerminalEventBus = createTerminalEventBus();
  return sharedTerminalEventBus;
}
