import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = [
  ["src/desktop/preload.cjs", "dist/desktop/preload.cjs"],
  ["src/desktop/renderer/index.html", "dist/desktop/renderer/index.html"],
  ["src/desktop/renderer/styles.css", "dist/desktop/renderer/styles.css"],
  // GSAP is vendored as a self-contained UMD build; the sandboxed renderer loads
  // it as a classic script (CSP `script-src 'self'`) before the ES module entry.
  ["node_modules/gsap/dist/gsap.min.js", "dist/desktop/renderer/vendor/gsap.min.js"],
];

for (const [source, target] of assets) {
  const destination = resolve(root, target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, source), destination);
}
