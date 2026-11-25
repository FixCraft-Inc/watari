export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  readonly #capacity: number;
  readonly #overflowValue: ((droppedCount: number) => T) | null;
  #closed = false;
  #overflowNotified = false;
  #droppedCount = 0;

  constructor(options?: {
    readonly capacity?: number;
    readonly overflowValue?: (droppedCount: number) => T;
  }) {
    this.#capacity = options?.capacity ?? 4_096;
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 2) {
      throw new Error("AsyncQueue capacity must be an integer of at least 2");
    }
    this.#overflowValue = options?.overflowValue ?? null;
  }

  push(value: T): void {
    if (this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    if (this.#values.length >= this.#capacity) {
      this.#values.shift();
      this.#droppedCount += 1;
      if (!this.#overflowNotified && this.#overflowValue) {
        if (this.#values.length >= this.#capacity - 1) {
          this.#values.shift();
          this.#droppedCount += 1;
        }
        this.#values.push(this.#overflowValue(this.#droppedCount));
        this.#overflowNotified = true;
      }
    }
    this.#values.push(value);
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) {
      if (this.#values.length < this.#capacity / 2) {
        this.#overflowNotified = false;
        this.#droppedCount = 0;
      }
      return { value, done: false };
    }
    if (this.#closed) {
      return { value: undefined, done: true };
    }
    return await new Promise<IteratorResult<T>>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
