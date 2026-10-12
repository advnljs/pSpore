import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = [
  ["src/desktop/preload.cjs", "dist/desktop/preload.cjs"],
  ["src/desktop/renderer/index.html", "dist/desktop/renderer/index.html"],
  ["src/desktop/renderer/styles.css", "dist/desktop/renderer/styles.css"],
  ["src/desktop/assets/pspore.svg", "dist/desktop/assets/pspore.svg"],
  ["src/desktop/assets/pspore.png", "dist/desktop/assets/pspore.png"],
  ["src/desktop/splash/index.html", "dist/desktop/splash/index.html"],
  ["src/desktop/splash/styles.css", "dist/desktop/splash/styles.css"],
  // GSAP is vendored as a self-contained UMD build; the sandboxed renderer loads
  // it as a classic script (CSP `script-src 'self'`) before the ES module entry.
  ["node_modules/gsap/dist/gsap.min.js", "dist/desktop/renderer/vendor/gsap.min.js"],
];

for (const [source, target] of assets) {
  const destination = resolve(root, target);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(resolve(root, source), destination);
}

// Skills that ship with the release. They land inside dist/ so `files: dist/**/*`
// carries them into the npm package and electron-builder into the app payload;
// the daemon links them into the workspace on startup.
const bundledSkills = resolve(root, "dist/bundled-skills");
await rm(bundledSkills, { recursive: true, force: true });
await cp(resolve(root, "bundled-skills"), bundledSkills, { recursive: true });
