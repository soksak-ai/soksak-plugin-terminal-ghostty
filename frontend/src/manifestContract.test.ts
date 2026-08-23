import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERMINAL_PLUGIN_CONTRACT, validateTerminalPluginManifestCommands } from "@soksak/soksak-contract-plugin-terminal";

describe("terminal plugin manifest contract", () => {
  it("declares every common terminal command", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
    expect(manifest).not.toHaveProperty("spec");
    expect(manifest.appVersionRequirement).toBe("0.0.1");
    expect(manifest.implements).toEqual([TERMINAL_PLUGIN_CONTRACT]);
    expect(manifest.sidecars.map((sidecar: { name: string }) => sidecar.name)).toEqual(["pty", "recovery"]);
    for (const sidecar of manifest.sidecars) {
      expect(sidecar.interface).toEqual({ id: expect.any(String), requirement: "0.0.1" });
    }
    expect(validateTerminalPluginManifestCommands(manifest.contributes.commands)).toEqual([]);
  });
});
