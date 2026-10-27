import { build } from "esbuild";
import { cp, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromRoot = (...parts) => resolve(root, ...parts);
const appSource = await readFile(fromRoot("web/src/app.ts"), "utf8");
const requestPolicySource = await readFile(fromRoot("web/src/request-policy.ts"), "utf8");
const exclusionsSource = await readFile(fromRoot("web/src/exclusions.ts"), "utf8");
const browserSource = [
  requestPolicySource.replace(/^export /gm, ""),
  exclusionsSource.replace(/^export /gm, ""),
  // Local modules are inlined above, so every `import { … } from "./x.js";` is stripped from the app source.
  appSource.replace(/^import \{[\s\S]*?\} from "\.\/[\w-]+\.js";\r?\n/gm, ""),
].join("\n");

await mkdir(fromRoot("dist/web/assets"), { recursive: true });
await build({
  stdin: {
    // A single stdin unit avoids esbuild walking restricted Windows parent directories.
    contents: browserSource,
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
