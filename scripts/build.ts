import solidPlugin from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./src/watari/index.ts"],
  plugins: [solidPlugin],
  target: "bun",
  define: {
    "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
  },
  compile: {
    target: "bun-linux-x64",
    outfile: "./dist/watari",
  },
});

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log}\n`);
  }
  process.exitCode = 1;
}
