const APP_TERMINAL_FOCUS_SELECTOR =
  '[data-terminal-surface="app"] [data-terminal-focus-root="true"]';
const GLOBAL_SHORTCUT_BYPASS_SELECTOR =
  '[data-terminal-surface="corkdiff"] [data-terminal-focus-root="true"]';

function activeTerminalElement(): HTMLElement | null {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return null;
  if (!activeElement.isConnected) return null;
  return activeElement;
}

export function isTerminalFocused(): boolean {
  const activeElement = activeTerminalElement();
  if (!activeElement) return false;
  return activeElement.closest(APP_TERMINAL_FOCUS_SELECTOR) !== null;
}

export function shouldBypassGlobalTerminalShortcuts(): boolean {
  const activeElement = activeTerminalElement();
  if (!activeElement) return false;
  return activeElement.closest(GLOBAL_SHORTCUT_BYPASS_SELECTOR) !== null;
}
