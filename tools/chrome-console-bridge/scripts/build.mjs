import { build } from "esbuild";
import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

// Clean dist folder without deleting the folder itself to avoid Finder focus shifts
try {
  const entries = await readdir(dist);
  for (const entry of entries) {
    await rm(resolve(dist, entry), { recursive: true, force: true });
  }
} catch {
  await mkdir(dist, { recursive: true });
}

await mkdir(resolve(dist, "icons"), { recursive: true });

await Promise.all([
  buildEntry("src/background/index.ts", "background.js"),
  buildEntry("src/bridge/index.ts", "bridge.js")
]);

await Promise.all([
  cp(resolve(root, "manifest.json"), resolve(dist, "manifest.json")),
  cp(resolve(root, "src/bridge/bridge.html"), resolve(dist, "bridge.html"))
]);

const icons = [
  ["icon16.png", 16],
  ["icon32.png", 32],
  ["icon48.png", 48],
  ["icon128.png", 128]
];

for (const [name, size] of icons) {
  await writeFile(resolve(dist, "icons", name), createPng(size));
}

async function buildEntry(entryPoint, outfile) {
  await build({
    entryPoints: [resolve(root, entryPoint)],
    outfile: resolve(dist, outfile),
    bundle: true,
    format: "esm",
    target: "chrome120",
    sourcemap: false
  });
}

function createPng(size) {
  const width = size;
  const height = size;
  const row = width * 4 + 1;
  const data = Buffer.alloc(row * height);

  for (let y = 0; y < height; y += 1) {
    const offset = y * row;
    data[offset] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = offset + 1 + x * 4;
      const blend = x / Math.max(width - 1, 1);
      data[pixel] = Math.round(190 * (1 - blend) + 15 * blend);
      data[pixel + 1] = Math.round(75 * (1 - blend) + 118 * blend);
      data[pixel + 2] = Math.round(43 * (1 - blend) + 110 * blend);
      data[pixel + 3] = 255;
    }
  }

  const chunks = [
    chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 6, 0, 0, 0])])),
    chunk("IDAT", deflateSync(data)),
    chunk("IEND", Buffer.alloc(0))
  ];

  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks]);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  return Buffer.concat([u32(data.length), body, u32(crc32(body))]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
