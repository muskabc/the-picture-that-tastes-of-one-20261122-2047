import { copyFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(scriptDir, "entry.png");

const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
mkdirSync(outDir, { recursive: true });

const outPath = join(outDir, "entry.png");
copyFileSync(sourcePath, outPath);
chmodSync(outPath, 0o644);

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const sourceHash = sha256(sourcePath);
const outputHash = sha256(outPath);

if (sourceHash !== outputHash) {
  console.error(`SHA-256 mismatch: source ${sourceHash} != output ${outputHash}`);
  process.exit(1);
}

console.log(`Wrote ${outPath} (sha256 ${outputHash})`);
