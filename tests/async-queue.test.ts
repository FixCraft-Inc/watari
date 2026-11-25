import { describe, expect, test } from "bun:test";

import { AsyncQueue } from "../src/watari/util/async-queue.ts";

describe("AsyncQueue", () => {
  test("bounds buffered values and visibly reports overflow", async () => {
    const queue = new AsyncQueue<string>({
      capacity: 3,
      overflowValue: (count) => `dropped:${count}`,
    });
    queue.push("one");
    queue.push("two");
    queue.push("three");
    queue.push("four");
    queue.close();

    const values: string[] = [];
    for await (const value of queue) {
      values.push(value);
    }
    expect(values).toEqual(["three", "dropped:2", "four"]);
  });
});
