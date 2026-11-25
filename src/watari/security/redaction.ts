const SECRET_KEY_PATTERN =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer|password|secret|credential)/iu;
const INLINE_SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu,
  /\b(?:sk|sk-ant|xox[baprs])-[-A-Za-z0-9_]{12,}\b/gu,
  /(["']?(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)["']?\s*[:=]\s*["']?)[^\s,"']+/giu,
];
const MAX_SANITIZED_STRING_LENGTH = 256 * 1024;
const MAX_SUMMARY_LENGTH = 64 * 1024;

export function sensitiveEnvironmentValues(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  return Object.entries(environment)
    .filter(([name, value]) => SECRET_KEY_PATTERN.test(name) && Boolean(value))
    .map(([, value]) => value)
    .filter(
      (value): value is string =>
        typeof value === "string" && value.length >= 8,
    )
    .sort((left, right) => right.length - left.length);
}

export function redactSecrets(
  input: string,
  environmentValues: readonly string[] = sensitiveEnvironmentValues(),
): string {
  let redacted = input;
  for (const value of environmentValues) {
    redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  for (const pattern of INLINE_SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, (match, prefix?: string) =>
      prefix ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return redacted;
}

export function redactUnknown(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return truncate(redactSecrets(value), MAX_SANITIZED_STRING_LENGTH);
  }
  if (depth >= 8) {
    return "[TRUNCATED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY_PATTERN.test(key)
          ? "[REDACTED]"
          : redactUnknown(item, depth + 1),
      ]),
    );
  }
  return value;
}

export function redactSummary(value: string): string {
  return truncate(stripTerminalControl(redactSecrets(value)), MAX_SUMMARY_LENGTH);
}

const CSI_SEQUENCE = /\u001B\[[0-9;?]*[ -/]*[@-~]/gu;
const OSC_SEQUENCE = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/gu;
const OTHER_ESCAPE = /\u001B[@-Z\\-_]/gu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu;

/**
 * Removes terminal control sequences from provider text.
 *
 * A harness writes its own coloured log lines to stderr, and Watari surfaces
 * stderr as warnings. Those sequences would be stored verbatim and then
 * replayed into the user's terminal, where they can repaint the screen or move
 * the cursor. Summaries are data, so they are stripped down to text.
 */
export function stripTerminalControl(value: string): string {
  return value
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(OTHER_ESCAPE, "")
    .replace(CONTROL_CHARACTERS, "");
}

/**
 * Clips text to `maximumLength` characters, the omission note included.
 *
 * The note used to be appended after keeping the full limit, so a long
 * reasoning block came out a few dozen characters over the 64 KiB the local
 * API accepts. Validation then rejected every broadcast carrying that row and
 * the service dropped each connected UI.
 */
function truncate(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  const note = (omitted: number) => `\n[TRUNCATED ${omitted} CHARACTERS]`;
  const kept = Math.max(0, maximumLength - note(value.length).length);
  return `${value.slice(0, kept)}${note(value.length - kept)}`;
}
