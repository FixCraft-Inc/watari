import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";

import {
  ManagedProcess,
  runContainedCommand,
} from "../src/watari/process/supervisor.ts";

const bun = process.execPath;

describe("ManagedProcess", () => {
  test("escalates cleanup for a stubborn detached process", async () => {
    const process = ManagedProcess.start({
      command: [bun, `${import.meta.dir}/fakes/stubborn.ts`],
      cwd: import.meta.dir,
      onJsonLine: () => undefined,
    });
    const startedAt = Date.now();
    const exitCode = await process.stop(40);
    expect(exitCode).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("cleans up provider groups when the parent receives SIGINT", async () => {
    const parent = spawn(bun, [`${import.meta.dir}/fakes/signal-parent.ts`], {
      cwd: import.meta.dir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = await firstLine(parent.stdout);
    const childPid = Number(/^READY (?<pid>\d+)$/u.exec(line)?.groups?.pid);
    expect(childPid).toBeGreaterThan(1);
    parent.kill("SIGINT");
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => parent.once("exit", (code, signal) => resolve({ code, signal })),
    );
    expect(exit).toEqual({ code: 130, signal: null });
    expect(processExists(childPid)).toBe(false);
  });
});

describe("runContainedCommand", () => {
  test("captures a short command and bounds provider output", async () => {
    const result = await runContainedCommand({
      command: [bun, "-e", "process.stdout.write('fixture')"],
      cwd: import.meta.dir,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "fixture", stderr: "" });

    await expect(runContainedCommand({
      command: [bun, "-e", "process.stdout.write('x'.repeat(256))"],
      cwd: import.meta.dir,
      maxOutputBytes: 64,
    })).rejects.toThrow("stdout exceeded 64 bytes");
  });
});

async function firstLine(stream: NodeJS.ReadableStream): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        resolve(buffer.slice(0, newline));
      }
    });
    stream.on("error", reject);
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
