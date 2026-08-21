import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const kit = pkg.dependencies["@soksak/soksak-kit-plugin-terminal"];
if (!kit?.startsWith("file:")) throw new Error("terminal kit must be a declared file dependency");
await build({ entryPoints: ["src/index.ts"], outfile: "../main.js", bundle: true, format: "esm", platform: "browser", target: "es2022", alias: { "@soksak/soksak-kit-plugin-terminal": fileURLToPath(new URL(`${kit.slice(5)}/src/index.ts`, import.meta.url)) } });
