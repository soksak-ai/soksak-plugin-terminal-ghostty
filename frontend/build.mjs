import { readFileSync } from "node:fs";
import { build } from "esbuild";

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
  throw new Error("usage: node build.mjs [--check]");
}
const checking = arguments_[0] === "--check";
const output = "../main.js";
const result = await build({
  entryPoints: ["src/index.ts"],
  outfile: output,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minifyWhitespace: true,
  write: !checking,
});
if (checking) {
  const expected = readFileSync(new URL(output, import.meta.url));
  if (result.outputFiles?.length !== 1 || !expected.equals(result.outputFiles[0].contents)) {
    throw new Error("generated main.js does not match the canonical plugin entry");
  }
}
