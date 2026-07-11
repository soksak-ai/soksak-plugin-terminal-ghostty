// soksak-plugin-terminal-ghostty 번들 빌드 — esbuild 단일 ESM main.js.
// ghostty-web 은 WASM 을 base64 data URL 로 자체 인라인하므로 별도 loader 불요(P8: 경로 해석 0).
import { build, context } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(root, "src");

const opts = {
  entryPoints: ["src/plugin-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  alias: { "@": SRC },
  define: {
    "process.env.NODE_ENV": '"production"',
    "import.meta.env.DEV": "false",
  },
  outfile: "main.js",
  minify: false,
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[terminal-ghostty] watching src → main.js …");
} else {
  await build(opts);
  console.log("[terminal-ghostty] built main.js");
}
