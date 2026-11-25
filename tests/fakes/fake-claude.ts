export {};

const decoder = new TextDecoder();
let buffer = "";
const mode = process.env.WATARI_FAKE_MODE ?? "normal";

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handle(message: Record<string, unknown>): void {
  if (message.type !== "user") {
    return;
  }
  if (mode === "malformed") {
    process.stdout.write("not-json\n");
  }
  process.stderr.write(
    `fake claude cwd=${process.cwd()} stdin_tty=${Boolean(process.stdin.isTTY)} token=${process.env.WATARI_FAKE_SECRET ?? "none"}\n`,
  );
  write({
    type: "system",
    subtype: "init",
    session_id: "claude-session-fake",
    claude_code_version: "2.1.241",
    cwd: process.cwd(),
  });
  write({
    type: "system",
    subtype: "api_retry",
    session_id: "claude-session-fake",
    attempt: 1,
  });
  write({
    type: "stream_event",
    session_id: "claude-session-fake",
    event: { delta: { type: "thinking_delta", thinking: "fixture reasoning" } },
  });
  write({
    type: "assistant",
    session_id: "claude-session-fake",
    message: {
      content: [
        { type: "text", text: "WATARI_PROBE_OK" },
        { type: "tool_use", id: "tool-1", name: "Read", input: { path: "fixture" } },
      ],
    },
  });
  write({
    type: "tool_progress",
    session_id: "claude-session-fake",
    tool_name: "Read",
    tool_use_id: "tool-1",
  });
  write({
    type: "result",
    subtype: "success",
    session_id: "claude-session-fake",
    is_error: false,
    duration_ms: 10,
    num_turns: 1,
  });
}

for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line) as Record<string, unknown>);
    }
    newline = buffer.indexOf("\n");
  }
}
