import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateTerminalPluginManifestCommands } from "@soksak/soksak-contract-plugin-terminal";

describe("terminal plugin manifest contract", () => {
  it("declares every common terminal command", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
    expect(validateTerminalPluginManifestCommands(manifest.contributes.commands)).toEqual([]);
  });
});
