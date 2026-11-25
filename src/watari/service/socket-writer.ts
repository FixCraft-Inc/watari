const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

export class JsonSocketWriter {
  readonly #socket: Bun.Socket<unknown>;
  readonly #queue: Buffer[] = [];
  #offset = 0;
  #queuedBytes = 0;

  constructor(socket: Bun.Socket<unknown>) {
    this.#socket = socket;
  }

  /** Bytes accepted but not yet written to the socket. */
  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  send(value: unknown): void {
    const data = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (this.#queuedBytes + data.byteLength > MAX_QUEUED_BYTES) {
      this.#socket.end();
      throw new Error("Watari local API client exceeded its bounded output queue");
    }
    this.#queue.push(data);
    this.#queuedBytes += data.byteLength;
    this.flush();
  }

  flush(): void {
    while (this.#queue.length > 0) {
      const current = this.#queue[0];
      if (!current) {
        return;
      }
      const written = this.#socket.write(current, this.#offset, current.byteLength - this.#offset);
      if (written <= 0) {
        return;
      }
      this.#offset += written;
      this.#queuedBytes -= written;
      if (this.#offset === current.byteLength) {
        this.#queue.shift();
        this.#offset = 0;
      }
    }
  }
}
