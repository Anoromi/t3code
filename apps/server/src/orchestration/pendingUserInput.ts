export function isStalePendingUserInputFailureDetail(detail: string | null | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("no active provider session is bound to this thread")
  );
}
