import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 1048576;
const EXPECTED_WIDTH = 1024;
const EXPECTED_HEIGHT = 1024;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(scriptDir, "entry.png");

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

// Read the true pixel dimensions from the image bytes themselves, so a
// corrupt or wrong-sized file is rejected before anything is written out.
// Supports JPEG (dimensions live in a SOF segment) and PNG (IHDR chunk).
function imageDimensions(data: Buffer): { width: number; height: number } {
  // JPEG: starts with FF D8 FF.
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        fail("entry.png is not a valid JPEG: bad marker prefix");
      }
      // Skip any 0xFF padding bytes between segments.
      let marker = data[offset + 1];
      while (marker === 0xff && offset + 2 < data.length) {
        offset += 1;
        marker = data[offset + 1];
      }
      // Standalone markers (RSTn, SOI, EOI, TEM) carry no length field.
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        offset += 2;
        continue;
      }
      const length = data.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > data.length) {
        fail("entry.png is not a valid JPEG: truncated segment");
      }
      // Start-of-frame markers (C0-CF except DHT C4, JPG C8, DAC CC).
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: data.readUInt16BE(offset + 5),
          width: data.readUInt16BE(offset + 7),
        };
      }
      if (marker === 0xda) {
        break; // Start of scan: compressed data follows, no more headers.
      }
      offset += 2 + length;
    }
    fail("entry.png is not a valid JPEG: no start-of-frame marker found");
  }

  // PNG: 8-byte signature, then IHDR holds width/height at bytes 16/20.
  const pngSignature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (data.length >= 24 && data.subarray(0, 8).equals(pngSignature)) {
    return {
      width: data.readUInt32BE(16),
      height: data.readUInt32BE(20),
    };
  }

  fail("entry.png is not a recognized image (expected a JPEG or PNG header)");
}

function main(): void {
  let source: Buffer;
  try {
    source = readFileSync(sourcePath);
  } catch (err) {
    fail(`cannot read ${sourcePath}: ${(err as Error).message}`);
  }

  // Validate the source image BEFORE writing anything to the output dir.
  if (source.length > MAX_BYTES) {
    fail(
      `entry.png is ${source.length} bytes, over the ${MAX_BYTES} byte limit`,
    );
  }
  const { width, height } = imageDimensions(source);
  if (width !== EXPECTED_WIDTH || height !== EXPECTED_HEIGHT) {
    fail(
      `entry.png is ${width}x${height}, expected ${EXPECTED_WIDTH}x${EXPECTED_HEIGHT}`,
    );
  }

  const outDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  const outPath = join(outDir, "entry.png");
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outPath, source);
    chmodSync(outPath, 0o644);
  } catch (err) {
    fail(`cannot write ${outPath}: ${(err as Error).message}`);
  }

  const written = readFileSync(outPath);
  const sourceHash = sha256(source);
  const outputHash = sha256(written);
  if (sourceHash !== outputHash) {
    fail(`SHA-256 mismatch: source ${sourceHash} != output ${outputHash}`);
  }

  console.log(
    `Wrote ${outPath} (${width}x${height}, ${source.length} bytes, sha256 ${outputHash})`,
  );
}

main();
