import { build } from "esbuild";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (...parts) => resolve(root, ...parts);

await mkdir(fromRoot("dist/web/assets"), { recursive: true });
await build({
  stdin: {
    contents: await readFile(fromRoot("web/src/app.ts"), "utf8"),
    loader: "ts",
    sourcefile: "app.ts",
  },
  bundle: true,
  format: "iife",
  minify: true,
  sourcemap: true,
  outfile: fromRoot("dist/web/app.js"),
  target: "es2020",
});
await Promise.all([
  cp(fromRoot("web/index.html"), fromRoot("dist/web/index.html")),
  cp(fromRoot("web/styles.css"), fromRoot("dist/web/styles.css")),
  cp(fromRoot("web/assets/recommendation-atlas.png"), fromRoot("dist/web/assets/recommendation-atlas.png")),
]);
