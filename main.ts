// Copy entry.png to the output directory after validating it, byte for byte.
//
// Design: async pipeline with explicit stages. Each stage either returns a
// value or throws a SubmissionError carrying a short code and a hint the
// operator can act on; the top level is the only place that prints and exits.
// Validation order is: format + true dimensions first, then the byte-size
// limit, then the copy. Nothing is written before every check has passed.
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIMITS = Object.freeze({
  maxBytes: 1_048_576,
  width: 1024,
  height: 1024,
});

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, "entry.png");
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

class SubmissionError extends Error {
  readonly hint: string;
  constructor(message: string, hint: string) {
    super(message);
    this.name = "SubmissionError";
    this.hint = hint;
  }
}

const digest = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

// --- format detection -------------------------------------------------------

type ImageKind = "jpeg" | "png";

const JPEG_SOI = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Buffer, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => bytes[i] === byte);
}

function detectKind(bytes: Buffer): ImageKind {
  if (startsWith(bytes, JPEG_SOI)) return "jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";
  throw new SubmissionError(
    "entry.png is not a JPEG or PNG image",
    "export the artwork again as a JPEG or PNG and replace entry.png",
  );
}

// --- dimension parsing ------------------------------------------------------

interface Size {
  width: number;
  height: number;
}

// Walk JPEG segments until a start-of-frame segment yields the dimensions.
// Segment layout: FF <marker> <len:2 bytes, includes itself> <payload...>.
// Markers 0xD0-0xD9, 0x01 and 0x00 carry no length field and are skipped as
// two bare bytes; anything else is stepped over by its declared length.
function jpegSize(bytes: Buffer): Size {
  let cursor = 2; // past the SOI marker
  for (;;) {
    if (cursor + 4 > bytes.length || bytes[cursor] !== 0xff) {
      throw new SubmissionError(
        "entry.png is a truncated or malformed JPEG",
        "re-export the JPEG and replace entry.png",
      );
    }
    const marker = bytes[cursor + 1];
    if (marker === 0xda) {
      throw new SubmissionError(
        "JPEG has no start-of-frame segment before the scan data",
        "re-export the JPEG and replace entry.png",
      );
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      cursor += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(cursor + 2);
    if (segmentLength < 2 || cursor + 2 + segmentLength > bytes.length) {
      throw new SubmissionError(
        "JPEG segment length runs past the end of the file",
        "re-export the JPEG and replace entry.png",
      );
    }
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 && // DHT
      marker !== 0xc8 && // JPG
      marker !== 0xcc; // DAC
    if (isFrame) {
      return {
        height: bytes.readUInt16BE(cursor + 5),
        width: bytes.readUInt16BE(cursor + 7),
      };
    }
    cursor += 2 + segmentLength;
  }
}

function pngSize(bytes: Buffer): Size {
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new SubmissionError(
      "PNG is missing its IHDR chunk",
      "re-export the PNG and replace entry.png",
    );
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function trueSize(bytes: Buffer, kind: ImageKind): Size {
  return kind === "jpeg" ? jpegSize(bytes) : pngSize(bytes);
}

// --- stages -----------------------------------------------------------------

async function loadSource(): Promise<Buffer> {
  try {
    return await readFile(SOURCE);
  } catch (cause) {
    throw new SubmissionError(
      `cannot read ${SOURCE}: ${(cause as Error).message}`,
      "make sure entry.png sits next to main.ts and is readable",
    );
  }
}

function validate(bytes: Buffer): Size {
  const kind = detectKind(bytes);
  const size = trueSize(bytes, kind);
  if (size.width !== LIMITS.width || size.height !== LIMITS.height) {
    throw new SubmissionError(
      `entry.png is ${size.width}x${size.height}, expected ${LIMITS.width}x${LIMITS.height}`,
      "resize or re-export the artwork to exactly 1024x1024",
    );
  }
  if (bytes.length > LIMITS.maxBytes) {
    throw new SubmissionError(
      `entry.png is ${bytes.length} bytes, over the ${LIMITS.maxBytes} byte limit`,
      "re-export with stronger compression until it fits under 1 MiB",
    );
  }
  return size;
}

async function copyVerified(bytes: Buffer, expectedHash: string): Promise<string> {
  const target = join(OUTPUT_DIR, "entry.png");
  try {
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(target, bytes);
    await chmod(target, 0o644);
  } catch (cause) {
    throw new SubmissionError(
      `cannot write ${target}: ${(cause as Error).message}`,
      "check that MAKEFUN_OUTPUT_DIR exists and is writable, or set it to another directory",
    );
  }
  let written: Buffer;
  try {
    written = await readFile(target);
  } catch (cause) {
    throw new SubmissionError(
      `cannot read back ${target}: ${(cause as Error).message}`,
      "check the output directory permissions and retry",
    );
  }
  const writtenHash = digest(written);
  if (written.length !== bytes.length) {
    throw new SubmissionError(
      `output is ${written.length} bytes, expected ${bytes.length} bytes: the copy was truncated`,
      "retry the run; if it repeats, check the output disk for space or errors",
    );
  }
  if (writtenHash !== expectedHash) {
    throw new SubmissionError(
      `SHA-256 mismatch after copy: source ${expectedHash} != output ${writtenHash}`,
      "retry the run; if it repeats, the output filesystem may be corrupting writes",
    );
  }
  return target;
}

// --- entry point ------------------------------------------------------------

async function run(): Promise<void> {
  const bytes = await loadSource();
  const size = validate(bytes);
  const hash = digest(bytes);
  const target = await copyVerified(bytes, hash);
  console.log(
    `Wrote ${target} (${size.width}x${size.height}, ${bytes.length} bytes, sha256 ${hash})`,
  );
}

try {
  await run();
} catch (error) {
  if (error instanceof SubmissionError) {
    console.error(`Error: ${error.message}\nHint: ${error.hint}`);
  } else {
    console.error(`Error: ${(error as Error).message}`);
  }
  process.exit(1);
}
