#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(root, "frontend/package.json"), "utf8"));
const requireText = (value, label) => { if (!workflow.includes(value)) throw new Error(`release workflow is missing ${label}: ${value}`); };
if (typeof manifest.spec === "string" || "schema" in manifest) throw new Error("plugin manifest repeats schema metadata");
if (manifest.appVersionRequirement !== "0.0.1") throw new Error("plugin app version requirement must be exact 0.0.1");
if (manifest.sidecars.some((sidecar) => sidecar.interface.requirement !== "0.0.1" || "version" in sidecar.interface)) throw new Error("sidecar consumers must use requirement");
if (pkg.engines?.node !== "26.7.0" || pkg.packageManager !== "pnpm@11.22.0") throw new Error("release toolchain must be exact");
if ("pnpm" in pkg) throw new Error("pnpm 11 settings belong in pnpm-workspace.yaml");
for (const obsolete of ["release/dependencies.json", "release/source-dependencies.json"]) {
  if (fs.existsSync(path.join(root, obsolete))) throw new Error(`${obsolete} is obsolete`);
}
requireText("release-template/build-release.mjs", "canonical plugin release builder");
requireText("bin/validate.mjs release", "canonical release validator");
requireText("--plugin-manifest plugin.json", "plugin conformance manifest");
requireText("ref: 418d6064fcdc5885be1ff73fd898fd7a0f778a0f", "canonical spec commit");
requireText("release-template/publish-canonical-release.mjs", "canonical immutable publisher");
requireText("GH_TOKEN: ${{ steps.release-token.outputs.token }}", "GitHub CLI release token");
requireText('node-version: "26.7.0"', "Node projection");
requireText('version: "11.22.0"', "pnpm projection");
if (workflow.includes("gh release create")) throw new Error("gh release create cannot publish protected immutable tags");
console.log("plugin release workflow contract: passed");
