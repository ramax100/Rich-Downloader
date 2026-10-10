import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "public");
const output = path.join(root, "dist");

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true });

const requiredFiles = [
  "index.html",
  "manifest.webmanifest",
  "service-worker.js",
  "assets/icon.png",
  "js/app.js",
  "js/scrapers/bundle.js",
];

for (const relativePath of requiredFiles) {
  const file = await stat(path.join(output, relativePath));
  if (!file.isFile()) throw new Error(`Missing web build asset: ${relativePath}`);
}

console.log(`Mori Web build created at ${output}`);
