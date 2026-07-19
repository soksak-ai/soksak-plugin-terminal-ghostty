// soksak-plugin-terminal-ghostty — Ghostty VT 엔진(WASM) 터미널의 진입점.
// 렌더러(term)+PTY+복원+IME 는 renderer.ts(createGhosttyRenderer)가 소유한다. 마운트 오케스트레이션
// (splitMode 분기·IO/포커스/명령 레지스트리·정리·split-pane 명령)은 kit(mountTerminalView·
// registerSplitPaneCommand)이 소유한다 — 여기는 렌더러 팩토리와 뷰 컨테이너·제목만 준다(xterm 과 대칭).
import { createGhosttyRenderer } from "./renderer";
import {
  ensureSidecar,
  createFocusCoordinator,
  createTerminalRegistry,
  registerTerminalCommands,
  mountTerminalView,
  registerSplitPaneCommand,
  type FocusCoordinator,
  type TerminalViewHandle,
  type PluginContext,
  type PluginViewContext,
} from "soksak-kit-terminal-common";

// per-view 마운트 상태 — 포커스 코디네이터(뷰 provider 라우팅) + kit 마운트 핸들(split 호스트·dispose).
const mounts = new Map<string, { focus: FocusCoordinator; handle: TerminalViewHandle }>();
// 활성 렌더러 레지스트리 — kit 공통 명령(send/clear/resume)이 대상을 해소한다.
const registry = createTerminalRegistry();

// 뷰 마운트 — splitMode 를 읽어 kit 오케스트레이터에 ghostty 렌더러 팩토리를 넘긴다.
function mountTerminal(
  container: HTMLElement,
  ctx: PluginContext,
  vctx: PluginViewContext,
): () => void {
  const app = ctx.app;
  const viewId = vctx.viewId;
  container.style.position = "relative";
  if (!app.pty) {
    vctx.setStatus({ code: "error", message: "pty 권한/표면 없음" });
    return () => {};
  }
  if (!viewId) {
    vctx.setStatus({ code: "error", message: "콘텐츠 배치 전용 뷰" });
    return () => {};
  }
  vctx.setStatus({ code: "connecting" });

  const cwd = vctx.restore?.cwd ?? vctx.root ?? undefined;
  const onTitle = (t: string): void => vctx.setTitle(t);
  // 설정이 분할 방식을 정한다: "within-tab" = 뷰 내부 pane, 그 외 = 단일 렌더러(탭분할=코어 panel.split).
  const withinTab = String(app.settings.get("splitMode") ?? "tab") === "within-tab";
  const focus = createFocusCoordinator();
  const handle = mountTerminalView(app, {
    mountRoot: container,
    viewId,
    withinTab,
    focus,
    registry,
    // pane 마다 ghostty 렌더러(term+PTY+복원+IME). 첫 pane 만 initialCommand(에이전트 자동 실행).
    createRenderer: (paneId, isFirst) =>
      createGhosttyRenderer({
        app,
        viewId: paneId,
        cwd,
        initialCommand: isFirst ? vctx.command ?? undefined : undefined,
        onTitle,
      }),
    setStatus: (s) => vctx.setStatus(s),
    emptyMessage: "빈 뷰 — 마지막 pane 이 닫혔습니다",
  });
  mounts.set(viewId, { focus, handle });

  return () => {
    handle.dispose();
    mounts.delete(viewId);
    container.replaceChildren();
  };
}

export default {
  activate(ctx: PluginContext) {
    const app = ctx.app;
    // 생존 서비스 사이드카(터미널 미러 복원)를 스폰한다 — detached 로 앱 종료를 넘어 살고,
    // 싱글턴 프로브가 중복을 흡수한다(xterm 과 같은 계약·같은 유닛 공유).
    ensureSidecar(app);
    if (app.ui?.registerView) {
      const cleanups = new WeakMap<HTMLElement, () => void>();
      ctx.subscriptions.push(
        app.ui.registerView("content", {
          mount(container, vctx) {
            cleanups.set(container, mountTerminal(container, ctx, vctx));
          },
          unmount(container) {
            cleanups.get(container)?.();
            cleanups.delete(container);
          },
          prepareFocusTransfer(_container, vctx) {
            if (vctx.viewId) mounts.get(vctx.viewId)?.focus.prepareTransfer();
          },
          focus(_container, vctx, request) {
            if (vctx.viewId) mounts.get(vctx.viewId)?.focus.request(request);
          },
        }),
      );
    }
    if (app.commands) {
      // 공통 명령(send·clear·resume) — kit. 대상은 registry 로 해소.
      registerTerminalCommands(ctx, registry);
      // ping — 이 플러그인의 정체성.
      ctx.subscriptions.push(
        app.commands.register("ping", {
          description: "Load/engine check — returns the plugin id and engine (E2E).",
          message: () => "고스티 엔진이 응답합니다.",
          handler: () => ({ ok: true, plugin: "soksak-plugin-terminal-ghostty", engine: "ghostty" }),
        }),
      );
      // split-pane — kit 이 명령 모양·i18n 을 소유. 대상 호스트 해소만 여기서(view 지정 또는 첫 within-tab).
      registerSplitPaneCommand(ctx, (view) => {
        const viewId = view ?? [...mounts].find(([, m]) => m.handle.splitHost)?.[0];
        const m = viewId ? mounts.get(viewId) : undefined;
        return m?.handle.splitHost ? { viewId: viewId!, host: m.handle.splitHost } : null;
      });
    }
  },
  deactivate() {
    for (const m of mounts.values()) m.handle.dispose();
    mounts.clear();
  },
};
