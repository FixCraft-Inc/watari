import { describe, expect, test } from "bun:test";

import { JsonSocketWriter } from "../src/watari/service/socket-writer.ts";

describe("bounded JSON socket output", () => {
  test("disconnects a backpressured client before its queue exceeds 8 MiB", () => {
    let ended = 0;
    const socket = {
      write: () => 0,
      end: () => {
        ended += 1;
      },
    } as unknown as Bun.Socket<unknown>;
    const writer = new JsonSocketWriter(socket);
    const oneMiB = "x".repeat(1024 * 1024);

    for (let index = 0; index < 7; index += 1) {
      writer.send({ output: oneMiB });
    }
    expect(ended).toBe(0);
    expect(() => writer.send({ output: oneMiB })).toThrow(
      "Watari local API client exceeded its bounded output queue",
    );
    expect(ended).toBe(1);
  });
});
