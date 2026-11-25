/** Only structured, temporary Codex failures permit another automatic turn.
 * Policy, authentication, quota and unknown errors require user intervention. */
export function isTransientCodexFailure(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const info = (payload as Record<string, unknown>)["codexErrorInfo"];
  if (info === "serverOverloaded" || info === "internalServerError" || info === "flexUnavailable") return true;
  if (typeof info !== "object" || info === null || Array.isArray(info)) return false;
  const entries = Object.entries(info);
  if (entries.length !== 1) return false;
  const [kind, details] = entries[0]!;
  if (!["httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts"].includes(kind)) return false;
  if (typeof details !== "object" || details === null) return false;
  const status = (details as Record<string, unknown>)["httpStatusCode"];
  return status === null || status === 408 || (typeof status === "number" && Number.isInteger(status) && status >= 500 && status <= 599);
}
