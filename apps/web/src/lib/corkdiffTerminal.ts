export const CORKDIFF_TERMINAL_ID = "corkdiff.nvim";

export function isCorkdiffTerminalId(terminalId: string): boolean {
  return terminalId === CORKDIFF_TERMINAL_ID;
}
