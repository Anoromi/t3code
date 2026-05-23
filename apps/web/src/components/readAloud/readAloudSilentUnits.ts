export const READ_ALOUD_CODE_HOLD_MS = 500;

export interface ReadAloudCodeHoldMetrics {
  readonly charCount: number;
  readonly lineCount: number;
  readonly holdMs: number;
  readonly label: string;
}

export function formatReadAloudCodeSizeLabel(input: {
  readonly lineCount: number;
  readonly charCount: number;
}): string {
  return input.lineCount === 1 ? "1 line" : `${input.lineCount} lines`;
}

export function computeReadAloudCodeHoldMetrics(code: string): ReadAloudCodeHoldMetrics {
  const visibleText = code.trim();
  const charCount = visibleText.length;
  const lineCount = visibleText.length === 0 ? 0 : visibleText.split(/\r\n|\r|\n/).length;

  return {
    charCount,
    lineCount,
    holdMs: READ_ALOUD_CODE_HOLD_MS,
    label: formatReadAloudCodeSizeLabel({ lineCount, charCount }),
  };
}
