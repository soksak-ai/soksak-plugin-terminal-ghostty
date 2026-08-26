import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "frontend/package.json"), "utf8"));
const lockfile = readFileSync(join(root, "frontend/pnpm-lock.yaml"), "utf8");
const makefile = readFileSync(join(root, "Makefile"), "utf8");
const scoped = (name) => /^@soksak(-ai)?\//.test(name);

const scopedDependencies = () => {
  const found = [];
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) if (scoped(name)) found.push([section, name, spec]);
  }
  return found;
};

test("package.json declares every @soksak dependency by exact version", () => {
  const found = scopedDependencies();
  assert.deepEqual(found.map(([, name]) => name), [
    "@soksak/soksak-contract-plugin-terminal",
    "@soksak/soksak-kit-plugin-terminal",
  ]);
  for (const [section, name, spec] of found) assert.match(spec, /^\d+\.\d+\.\d+$/, `${section}.${name}`);
});

test("pnpm-lock.yaml resolves @soksak packages by integrity without a tarball URL", () => {
  assert.equal(/github\.com\/soksak-ai\/soksak-(kit|contract)-plugin-terminal/.test(lockfile), false, "lockfile pins a GitHub tarball");
  const resolutions = new Map(
    [...lockfile.matchAll(/^  '(@soksak(?:-ai)?\/[^@']+@[^'(]+)':\n    resolution: \{([^}]*)\}/gm)].map(([, key, resolution]) => [key, resolution]),
  );
  assert.deepEqual([...resolutions.keys()].sort(), scopedDependencies().map(([, name, spec]) => `${name}@${spec}`).sort());
  for (const [key, resolution] of resolutions) assert.match(resolution, /^integrity: sha512-[A-Za-z0-9+/=]+$/, key);
  for (const [, name, spec] of scopedDependencies()) {
    assert.match(lockfile, new RegExp(`^      '${name}':\\n        specifier: ${spec.replaceAll(".", "[.]")}\\n`, "m"), name);
  }
});

const makeVariable = (name) => {
  const match = makefile.match(new RegExp(`^${name} = (.+)$`, "m"));
  assert.ok(match, name);
  return match[1];
};
// A parent make exports REGISTRY and MAKEFLAGS to recipe processes; a bare PATH keeps them out.
const run = (args, env = {}) =>
  spawnSync("make", args, { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
const refused = (result, message) => {
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, message);
  assert.doesNotMatch(result.stdout, /BUILD_ENVIRONMENT_READY/);
};

test("Makefile installs from a command-line REGISTRY with the scoped registry flags", () => {
  assert.equal(
    makeVariable("registry_flags"),
    "--@soksak:registry=$(REGISTRY) --@soksak-ai:registry=$(REGISTRY) --config.minimum-release-age=0",
  );
  assert.match(makefile, /^guard:$/m);
  assert.match(makefile, /^prepare: guard preflight$/m);
  assert.match(makefile, /pnpm --dir frontend install --frozen-lockfile \$\(if \$\(findstring command line,\$\(origin REGISTRY\)\),\$\(registry_flags\)\)/);
  assert.match(makefile, /shasum -a 256 frontend\/pnpm-workspace\.yaml/);
  const runFlags = "\\$\\(if \\$\\(findstring command line,\\$\\(origin REGISTRY\\)\\),\\$\\(registry_flags\\)\\)";
  const runEnv = "CI=1 PNPM_DISABLE_SELF_UPDATE_CHECK=1 pnpm --dir frontend";
  assert.match(makefile, new RegExp(`^prepare: guard preflight\\n\\t@before=[^\\n]*; ${runEnv} install --frozen-lockfile ${runFlags} \\|\\| exit`, "m"));
  assert.match(makefile, new RegExp(`^build: prepare\\n\\t@${runEnv} ${runFlags} build$`, "m"));
  assert.match(makefile, new RegExp(`^\\t@${runEnv} ${runFlags} verify$`, "m"));
  assert.doesNotMatch(makefile, /pnpm --dir frontend install[^\n]* && /);
  assert.match(makefile, /node -p '[^']*dependencies[^']*devDependencies[^']*peerDependencies/);
  refused(run(["prepare", "REGISTRY=localhost:4873"]), /REGISTRY must be an absolute URL/);
  refused(run(["prepare", "REGISTRY="]), /REGISTRY must be an absolute URL/);
  refused(run(["prepare"], { REGISTRY: "http://127.0.0.1:4873" }), /REGISTRY from the environment is refused/);
  refused(run(["build"], { REGISTRY: "http://127.0.0.1:4873" }), /REGISTRY from the environment is refused/);
  refused(run(["verify"], { REGISTRY: "http://127.0.0.1:4873" }), /REGISTRY from the environment is refused/);
});

test("Makefile requires REGISTRY on the command line because the package depends on @soksak", () => {
  const dependency = /REGISTRY required: this package depends on @soksak\/soksak-contract-plugin-terminal/;
  refused(run(["prepare"]), dependency);
  refused(run(["build"]), dependency);
  refused(run(["verify"]), dependency);
});

test("README documents the REGISTRY requirement verbatim", () => {
  for (const name of ["README.md", "README.ko.md"]) {
    const readme = readFileSync(join(root, name), "utf8");
    assert.ok(readme.includes("make verify REGISTRY=http://host:port/"), name);
    assert.ok(readme.includes("REGISTRY required: this package depends on @soksak/"), name);
    assert.doesNotMatch(readme, /^make (prepare|build|verify)\b(?!.*REGISTRY=)/m, name);
  }
});
