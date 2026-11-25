import { describe, expect, test } from "bun:test";

import {
  MAX_CLIPBOARD_BYTES,
  copyToClipboard,
  describeCopy,
  hostCopyCommand,
  osc52Sequence,
} from "../src/watari/tui/clipboard.ts";
import { resolveCtrlC, isCancelChord, isCopyChord } from "../src/watari/tui/keys.ts";
import { CURSOR_COLOR_RESET, restoreCursorColor } from "../src/watari/tui/app.tsx";

const ESC = "\u001B";
const BEL = "\u0007";

function collector(): { stream: { write(chunk: string): boolean; isTTY: boolean }; written: string[] } {
  const written: string[] = [];
  return {
    written,
    stream: {
      isTTY: true,
      write(chunk: string) {
        written.push(chunk);
        return true;
      },
    },
  };
}

describe("OSC 52", () => {
  test("a plain terminal gets the bare sequence with base64 payload", () => {
    const sequence = osc52Sequence("watari", {});
    expect(sequence).toBe(`${ESC}]52;c;${Buffer.from("watari").toString("base64")}${BEL}`);
  });

  test("tmux gets a passthrough with its escapes doubled", () => {
    const sequence = osc52Sequence("hi", { TMUX: "/tmp/tmux-1000/default,123,0" });
    expect(sequence.startsWith(`${ESC}Ptmux;`)).toBe(true);
    expect(sequence.endsWith(`${ESC}\\`)).toBe(true);
    expect(sequence).toContain(`${ESC}${ESC}]52;c;`);
  });

  test("screen gets its own passthrough, undoubled", () => {
    const sequence = osc52Sequence("hi", { STY: "1234.pts-0.host" });
    expect(sequence.startsWith(`${ESC}P${ESC}]52;c;`)).toBe(true);
    expect(sequence).not.toContain(`${ESC}${ESC}`);
  });

  test("unicode survives the round trip", () => {
    const text = "héllo ⇌ 世界";
    const sequence = osc52Sequence(text, {});
    const payload = sequence.slice(`${ESC}]52;c;`.length, -1);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe(text);
  });
});

describe("host clipboard helpers", () => {
  const all = () => true;
  const none = () => false;

  test("wayland prefers wl-copy, X11 falls back through xclip and xsel", () => {
    expect(hostCopyCommand("linux", { WAYLAND_DISPLAY: "wayland-0" }, all)).toEqual(["wl-copy"]);
    expect(hostCopyCommand("linux", {}, all)).toEqual(["xclip", "-selection", "clipboard"]);
    expect(hostCopyCommand("linux", {}, (name) => name === "xsel")).toEqual([
      "xsel",
      "--clipboard",
      "--input",
    ]);
  });

  test("wl-copy still answers on X11 when nothing else is installed", () => {
    expect(hostCopyCommand("linux", {}, (name) => name === "wl-copy")).toEqual(["wl-copy"]);
  });

  test("WSL reaches the Windows clipboard through interop", () => {
    expect(hostCopyCommand("linux", {}, (name) => name === "clip.exe")).toEqual(["clip.exe"]);
  });

  test("macOS and Windows use their own", () => {
    expect(hostCopyCommand("darwin", {}, all)).toEqual(["pbcopy"]);
    expect(hostCopyCommand("win32", {}, all)).toEqual(["clip"]);
  });

  test("a machine with no helper reports none rather than guessing", () => {
    expect(hostCopyCommand("linux", {}, none)).toBeNull();
    expect(hostCopyCommand("darwin", {}, none)).toBeNull();
  });
});

describe("copying", () => {
  test("the terminal route alone still counts as copied", async () => {
    const { stream, written } = collector();
    const outcome = await copyToClipboard("selected text", {
      platform: "linux",
      env: {},
      stream,
      has: () => false,
    });

    expect(outcome.copied).toBe(true);
    expect(outcome.viaTerminal).toBe(true);
    expect(outcome.viaHost).toBe(false);
    expect(written[0]).toContain("]52;c;");
  });

  test("no TTY and no helper is an honest failure, not a silent one", async () => {
    const outcome = await copyToClipboard("text", {
      platform: "linux",
      env: {},
      stream: { isTTY: false, write: () => true },
      has: () => false,
    });

    expect(outcome.copied).toBe(false);
    expect(outcome.error).toContain("no clipboard route");
    expect(describeCopy(outcome, "selection")).toContain("no clipboard route");
  });

  test("an empty copy is refused instead of clearing the clipboard", async () => {
    const outcome = await copyToClipboard("", { platform: "linux", env: {}, has: () => false });
    expect(outcome.copied).toBe(false);
    expect(outcome.error).toBe("nothing to copy");
  });

  test("an oversized selection is refused with its size named", async () => {
    const { stream } = collector();
    const outcome = await copyToClipboard("x".repeat(MAX_CLIPBOARD_BYTES + 1), {
      platform: "linux",
      env: {},
      stream,
      has: () => false,
    });

    expect(outcome.copied).toBe(false);
    expect(outcome.error).toContain("copy limit");
  });

  test("the message names the route when only one worked", () => {
    expect(describeCopy({ copied: true, viaTerminal: true, viaHost: false }, "selection")).toBe(
      "copied selection via terminal",
    );
    expect(describeCopy({ copied: true, viaTerminal: false, viaHost: true }, "selection")).toBe(
      "copied selection via host clipboard",
    );
    expect(describeCopy({ copied: true, viaTerminal: true, viaHost: true }, "selection")).toBe(
      "copied selection",
    );
  });
});

describe("ctrl+c", () => {
  test("clears the smallest thing in front of the user first", () => {
    expect(resolveCtrlC({ hasSelection: true, composer: "half typed", armed: false })).toBe(
      "clear-selection",
    );
    expect(resolveCtrlC({ hasSelection: false, composer: "half typed", armed: false })).toBe(
      "clear-composer",
    );
  });

  test("detaching takes two presses, never one", () => {
    expect(resolveCtrlC({ hasSelection: false, composer: "", armed: false })).toBe("arm-detach");
    expect(resolveCtrlC({ hasSelection: false, composer: "", armed: true })).toBe("detach");
  });

  test("an armed press still clears first, so nothing is lost by accident", () => {
    expect(resolveCtrlC({ hasSelection: false, composer: "typed", armed: true })).toBe(
      "clear-composer",
    );
    expect(resolveCtrlC({ hasSelection: true, composer: "", armed: true })).toBe("clear-selection");
  });

  test("whitespace alone is not text worth protecting", () => {
    expect(resolveCtrlC({ hasSelection: false, composer: "   ", armed: false })).toBe("arm-detach");
  });
});

describe("chords", () => {
  test("copy and cancel are different keys", () => {
    expect(isCopyChord({ name: "c", ctrl: true, shift: true })).toBe(true);
    expect(isCancelChord({ name: "c", ctrl: true, shift: true })).toBe(false);
    expect(isCancelChord({ name: "c", ctrl: true, shift: false })).toBe(true);
    expect(isCopyChord({ name: "c", ctrl: true, shift: false })).toBe(false);
  });

  test("ctrl+y copies too, for terminals that keep ctrl+shift+c", () => {
    expect(isCopyChord({ name: "y", ctrl: true, shift: false })).toBe(true);
    expect(isCopyChord({ name: "y", ctrl: false, shift: false })).toBe(false);
  });

  test("copy accepts uppercase and compatibility-parser kitty forms", () => {
    expect(isCopyChord({ name: "C", ctrl: true, shift: false, sequence: "C" })).toBe(true);
    expect(isCopyChord({ name: "c", ctrl: true, shift: false, raw: "\u001b[99;6u" })).toBe(true);
    expect(isCancelChord({ name: "C", ctrl: true, shift: false })).toBe(false);
  });

  test("an unmodified key is neither", () => {
    expect(isCopyChord({ name: "c", ctrl: false, shift: true })).toBe(false);
    expect(isCancelChord({ name: "x", ctrl: true, shift: false })).toBe(false);
  });
});

describe("handing the terminal back", () => {
  test("the cursor colour is reset on the way out, and only on a terminal", () => {
    const terminal = collector();
    restoreCursorColor({ ...terminal.stream, isTTY: true });
    expect(terminal.written).toEqual([`${ESC}]112${BEL}`]);
    expect(CURSOR_COLOR_RESET).toBe(`${ESC}]112${BEL}`);

    const piped = collector();
    restoreCursorColor({ ...piped.stream, isTTY: false });
    expect(piped.written).toEqual([]);
  });

  test("a stdout that has already gone does not take the exit with it", () => {
    expect(() =>
      restoreCursorColor({
        isTTY: true,
        write() {
          throw new Error("EPIPE");
        },
      }),
    ).not.toThrow();
  });
});
