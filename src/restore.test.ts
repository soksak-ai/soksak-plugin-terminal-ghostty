import { describe, it, expect, vi } from "vitest";
import { ensureSidecar } from "./restore";
import type { PluginApi } from "./host";

describe("유닛 선택의 단일진실 = 매니페스트", () => {
  // 계약: 어느 엔진 유닛을 스폰할지는 **매니페스트 sidecars[] 가 정한다**(SPEC: "The plugin manifest
  // selects the unit"). 번들에 유닛명을 상수로 굳히면 매니페스트만 바꿨을 때 무음으로 옛 엔진이
  // 스폰된다 — declared ≠ actual 이고, 그 어긋남은 아무 데서도 안 잡힌다.
  it("매니페스트가 선언한 유닛을 스폰한다(상수가 아니라)", async () => {
    const spawn = vi.fn(async () => 1);
    const app = {
      locale: () => "ko",
      activity: { publish: () => {} },
      // 코어가 이 플러그인의 매니페스트에서 계약을 구현한다고 선언된 유닛을 알려 준다.
      process: { spawn, sidecarName: () => "terminal-wezterm" },
    } as unknown as PluginApi;
    ensureSidecar(app);
    expect(spawn).toHaveBeenCalledWith("sidecar:terminal-wezterm", [], { detached: true });
  });
});
