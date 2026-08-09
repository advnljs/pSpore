import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = [
  ["src/desktop/preload.cjs", "dist/desktop/preload.cjs"],
  ["src/desktop/renderer/index.html", "dist/desktop/renderer/index.html"],
  ["src/desktop/renderer/styles.css", "dist/desktop/renderer/styles.css"],
];

for (const [source, target] of assets) {
  const destination = resolve(root, target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, source), destination);
}
