import { ManagedProcess } from "../../src/watari/process/supervisor.ts";

const child = ManagedProcess.start({
  command: [process.execPath, `${import.meta.dir}/stubborn.ts`],
  cwd: import.meta.dir,
  onJsonLine: () => undefined,
});

process.stdout.write(`READY ${child.pid}\n`);
await new Promise<void>(() => undefined);
