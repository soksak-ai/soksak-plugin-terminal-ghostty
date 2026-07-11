// soksak-plugin-terminal-ghostty 번들 빌드 — esbuild 단일 ESM main.js.
// ghostty-web 은 WASM 을 base64 data URL 로 자체 인라인하므로 별도 loader 불요(P8: 경로 해석 0).
import { build, context } from "esbuild";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(root, "src");

// ── kit 해석: 선언(package.json dependencies) + 발견(SOKSAK_HOME/kits/<이름>) ──
// symlink·상대 위상 금지 — 소비자는 이름만 선언하고, 위치는 레지스트라(kits/)에서 발견한다.
// tsc 도 같은 발견을 쓴다: tsconfig.paths.json 을 여기서 생성(extends 로 공급).
const SOKSAK_HOME = process.env.SOKSAK_HOME ?? path.join(os.homedir(), ".soksak-dev");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const kits = Object.fromEntries(
  Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .map((n) => [n, path.join(SOKSAK_HOME, "kits", n, "src", "index.ts")])
    .filter(([, p]) => fs.existsSync(p)),
);
fs.writeFileSync(
  path.join(root, "tsconfig.paths.json"),
  JSON.stringify(
    { compilerOptions: { paths: { "@/*": ["./src/*"], ...Object.fromEntries(Object.entries(kits).map(([n, p]) => [n, [p]])) } } },
    null,
    2,
  ) + "\n",
);

const opts = {
  entryPoints: ["src/plugin-entry.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  alias: { "@": SRC, ...kits },
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
