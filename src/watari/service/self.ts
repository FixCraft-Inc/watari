export function selfCommand(args: readonly string[]): [string, ...string[]] {
  const main = Bun.main;
  const compiled = main.startsWith("/$bunfs/") || main === process.execPath;
  return compiled ? [process.execPath, ...args] : [process.execPath, main, ...args];
}
