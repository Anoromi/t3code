import { init } from "ghostty-web";

let initPromise: Promise<void> | null = null;

export function ensureGhosttyWebReady(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = init().catch((error) => {
    initPromise = null;
    throw error;
  });
  return initPromise;
}
