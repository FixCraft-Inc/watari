export const AGENT_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

const RESERVED_ALIASES = new Set(["all", "user", "watari"]);

export function isAgentAlias(value: unknown): value is string {
  return (
    typeof value === "string" &&
    AGENT_ALIAS_PATTERN.test(value) &&
    !RESERVED_ALIASES.has(value.toLowerCase())
  );
}

export const AGENT_ALIAS_HELP =
  "an agent alias using 1-64 letters, digits, dots, underscores, or hyphens";
