/** Shared byte limits for provider replies and authenticated control requests. */
export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/** Cancel oversized streams before buffering them, including chunked bodies. */
export async function readBoundedText(message: Pick<Response, "headers" | "body">, maxBytes: number): Promise<string> {
  const declared = Number(message.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await message.body?.cancel().catch(() => undefined);
    throw new BodyTooLargeError(maxBytes);
  }
  if (!message.body) return "";
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new BodyTooLargeError(maxBytes);
      chunks.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(chunks, size));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
