export type BlockedFetchAttempt = {
  host: string;
  testLabel: string;
};

export function currentTestLabel(
  state: {
    currentTestName?: string | null;
    testPath?: string | null;
  },
  lastCompleted?: string | null,
): string {
  const file = state.testPath
    ? state.testPath.replaceAll("\\", "/").split("/").slice(-2).join("/")
    : "unknown-file";
  if (state.currentTestName) return `${file} :: ${state.currentTestName}`;
  return `${file} :: between tests (last: ${lastCompleted ?? "none"})`;
}

export function formatBlockedFetchError(attempts: BlockedFetchAttempt[]): string {
  const details = attempts
    .map((attempt) => `${attempt.host} (test: ${attempt.testLabel})`)
    .join(", ");
  return `[test guard] outbound API fetch attempted during test: ${details}`;
}
