import { spawn } from "node:child_process";

/**
 * Getting text out of a fullscreen TUI.
 *
 * A terminal application that draws its own screen and grabs the mouse has
 * taken the two things a user normally copies with. Watari therefore owns the
 * whole path: it keeps its own selection, and it puts the result on the real
 * clipboard by two independent routes.
 *
 * OSC 52 asks the terminal emulator to do it. That is the only route that works
 * over SSH, inside tmux, and in a container, because it travels on the same
 * stream as the drawing. Not every terminal honours it, and some honour it only
 * once the user opts in, so it is never trusted on its own.
 *
 * A host helper (`wl-copy`, `xclip`, `pbcopy`, `clip.exe`) is the second route.
 * It is reliable when Watari runs on the same machine as the display server and
 * useless when it does not. Between them one usually lands, and attempting both
 * costs a few milliseconds.
 */

const ESC = "\u001B";
const BEL = "\u0007";

/** Longest text Watari will put on the clipboard in one go. */
export const MAX_CLIPBOARD_BYTES = 512 * 1024;

export interface ClipboardOutcome {
  /** True when at least one route accepted the text. */
  readonly copied: boolean;
  /** The terminal was asked through OSC 52. */
  readonly viaTerminal: boolean;
  /** A host clipboard helper accepted the text. */
  readonly viaHost: boolean;
  /** Populated when nothing worked, for the status line. */
  readonly error?: string;
}

/**
 * The OSC 52 sequence that carries `text` to the terminal's clipboard.
 *
 * tmux and screen do not forward an unknown OSC by default, so the sequence is
 * wrapped in the passthrough each of them understands. The wrapping is chosen
 * from the environment rather than sent always, because a terminal that is not
 * running a multiplexer would print the wrapper as text.
 */
export function osc52Sequence(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const payload = Buffer.from(text, "utf8").toString("base64");
  const sequence = `${ESC}]52;c;${payload}${BEL}`;
  if (env["TMUX"]) {
    // tmux swallows an OSC it does not recognise unless it is wrapped in a
    // passthrough whose inner escapes are doubled.
    return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ESC}\\`;
  }
  if (env["STY"]) {
    return `${ESC}P${sequence}${ESC}\\`;
  }
  return sequence;
}

/**
 * The host helper to pipe text into, or null when this machine has none.
 *
 * `has` is injected so the resolution order can be tested without depending on
 * what happens to be installed on the machine running the suite.
 */
export function hostCopyCommand(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  has: (name: string) => boolean,
): readonly [string, ...string[]] | null {
  if (platform === "darwin") {
    return has("pbcopy") ? ["pbcopy"] : null;
  }
  if (platform === "win32") {
    return has("clip") ? ["clip"] : null;
  }
  // A Wayland session usually also answers X11 through XWayland, but wl-copy is
  // the one that survives a compositor without an X server at all.
  if (env["WAYLAND_DISPLAY"] && has("wl-copy")) return ["wl-copy"];
  if (has("xclip")) return ["xclip", "-selection", "clipboard"];
  if (has("xsel")) return ["xsel", "--clipboard", "--input"];
  if (has("wl-copy")) return ["wl-copy"];
  // WSL reaches the Windows clipboard through the interop layer.
  if (has("clip.exe")) return ["clip.exe"];
  return null;
}

/** Terminal-side half of a copy. Returns false when there is no TTY to write to. */
export function writeOsc52(
  text: string,
  stream: { write(chunk: string): boolean; isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (stream.isTTY === false) return false;
  try {
    stream.write(osc52Sequence(text, env));
    return true;
  } catch {
    return false;
  }
}

/** Host-side half of a copy. Resolves false rather than throwing. */
export async function writeHostClipboard(
  text: string,
  command: readonly [string, ...string[]] | null,
): Promise<boolean> {
  if (!command) return false;
  const [executable, ...args] = command;
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(executable, args, { stdio: ["pipe", "ignore", "ignore"] });
      // A helper that never exits (wl-copy holds the selection by design on
      // some compositors) must not hold the UI, so the write itself is the
      // success signal and the exit code only downgrades it.
      const timer = setTimeout(() => finish(true), 500);
      timer.unref?.();
      child.once("error", () => {
        clearTimeout(timer);
        finish(false);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        finish(code === 0);
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(text);
    } catch {
      finish(false);
    }
  });
}

export interface ClipboardEnvironment {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly stream?: { write(chunk: string): boolean; isTTY?: boolean };
  readonly has?: (name: string) => boolean;
}

/** Puts `text` on the clipboard by every route this machine offers. */
export async function copyToClipboard(
  text: string,
  environment: ClipboardEnvironment = {},
): Promise<ClipboardOutcome> {
  if (text === "") {
    return { copied: false, viaTerminal: false, viaHost: false, error: "nothing to copy" };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_CLIPBOARD_BYTES) {
    return {
      copied: false,
      viaTerminal: false,
      viaHost: false,
      error: `selection is ${Math.round(bytes / 1024)}KB, over the ${MAX_CLIPBOARD_BYTES / 1024}KB copy limit`,
    };
  }

  const platform = environment.platform ?? process.platform;
  const env = environment.env ?? process.env;
  const viaTerminal = writeOsc52(text, environment.stream ?? process.stdout, env);
  const viaHost = await writeHostClipboard(
    text,
    hostCopyCommand(platform, env, environment.has ?? commandExists),
  );

  if (viaTerminal || viaHost) {
    return { copied: true, viaTerminal, viaHost };
  }
  return {
    copied: false,
    viaTerminal: false,
    viaHost: false,
    error: "no clipboard route: terminal refused OSC 52 and no helper is installed",
  };
}

/** Wording for the status line, naming the route so a silent failure is visible. */
export function describeCopy(outcome: ClipboardOutcome, what: string): string {
  if (!outcome.copied) return outcome.error ?? "copy failed";
  const route = outcome.viaHost && outcome.viaTerminal
    ? ""
    : outcome.viaHost
    ? " via host clipboard"
    : " via terminal";
  return `copied ${what}${route}`;
}

const lookupCache = new Map<string, boolean>();

function commandExists(name: string): boolean {
  const cached = lookupCache.get(name);
  if (cached !== undefined) return cached;
  const directories = (process.env["PATH"] ?? "").split(process.platform === "win32" ? ";" : ":");
  const found = directories.some((directory) => {
    if (!directory) return false;
    try {
      return Bun.file(`${directory}/${name}`).size > 0;
    } catch {
      return false;
    }
  });
  lookupCache.set(name, found);
  return found;
}
