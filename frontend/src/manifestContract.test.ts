import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TERMINAL_PLUGIN_CONTRACT, validateTerminalPluginManifestCommands } from "@soksak/soksak-contract-plugin-terminal";

describe("terminal plugin manifest contract", () => {
  it("declares every common terminal command", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
    expect(manifest).not.toHaveProperty("spec");
    expect(manifest.appVersionRequirement).toBe("0.0.1");
    expect(manifest.permissions).toContain("ui:statusbar");
    expect(manifest.implements).toEqual([TERMINAL_PLUGIN_CONTRACT]);
    expect(manifest.runtimeDependencies.sidecars.map((sidecar: { id: string }) => sidecar.id)).toEqual(["soksak-sidecar-pty", "soksak-sidecar-terminal-ghostty"]);
    for (const sidecar of manifest.runtimeDependencies.sidecars) expect(sidecar).toEqual({ id: expect.any(String), version: expect.any(String), url: expect.stringMatching(/release\.json$/), size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(validateTerminalPluginManifestCommands(manifest.contributes.commands)).toEqual([]);
  });
});
