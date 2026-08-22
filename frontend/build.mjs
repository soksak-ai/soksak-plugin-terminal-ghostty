import { build } from "esbuild";
await build({ entryPoints: ["src/index.ts"], outfile: "../main.js", bundle: true, format: "esm", platform: "browser", target: "es2022" });
