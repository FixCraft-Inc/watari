import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { TESTED_CODEX_VERSION } from "../src/watari/compatibility.ts";
const repositoryRoot = resolve(import.meta.dir, "..");
const generatedRoot = join(repositoryRoot, "src", "generated", "codex");
const executable = process.env.WATARI_CODEX_BIN ?? Bun.which("codex");

if (!executable) {
  throw new Error("codex executable not found; set WATARI_CODEX_BIN");
}

const versionResult = Bun.spawnSync([executable, "--version"], {
  cwd: repositoryRoot,
  stdout: "pipe",
  stderr: "pipe",
});
const versionOutput = versionResult.stdout.toString().trim();
const installedVersion = /(?:codex-cli\s+)?(?<version>\d+\.\d+\.\d+)/u.exec(
  versionOutput,
)?.groups?.version;

if (versionResult.exitCode !== 0 || installedVersion !== TESTED_CODEX_VERSION) {
  throw new Error(
    `expected Codex ${TESTED_CODEX_VERSION}, found ${versionOutput || "unknown"}`,
  );
}

rmSync(generatedRoot, { recursive: true, force: true });
mkdirSync(generatedRoot, { recursive: true });

const generation = Bun.spawnSync(
  [executable, "app-server", "generate-ts", "--out", generatedRoot],
  {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  },
);

if (generation.exitCode !== 0) {
  throw new Error(
    `Codex protocol generation failed: ${generation.stderr.toString().trim()}`,
  );
}

function generatedFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? generatedFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts"))
    .sort();
}

const hasher = new Bun.CryptoHasher("sha256");
const files = generatedFiles(generatedRoot);
for (const file of files) {
  hasher.update(relative(generatedRoot, file));
  hasher.update("\0");
  hasher.update(readFileSync(file));
  hasher.update("\0");
}

writeFileSync(
  join(generatedRoot, "protocol-manifest.json"),
  `${JSON.stringify(
    {
      generator: "codex app-server generate-ts",
      codexVersion: installedVersion,
      generatedFileCount: files.length,
      sha256: hasher.digest("hex"),
    },
    null,
    2,
  )}\n`,
  { mode: 0o644 },
);

process.stdout.write(
  `Generated ${files.length} Codex ${installedVersion} protocol files.\n`,
);
