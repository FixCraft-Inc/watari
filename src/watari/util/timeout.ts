/**
 * Bounds a promise that Watari cannot afford to wait on forever.
 *
 * The promise is not cancelled — nothing in a provider protocol can be — so the
 * caller is responsible for whatever cleanup abandoning it implies. It exists
 * so a wedged harness cannot hold a shutdown, a startup, or the user's terminal.
 */
export async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${message} within ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
