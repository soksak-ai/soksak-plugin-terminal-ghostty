// soksak-plugin-terminal-ghostty — Ghostty VT 엔진(WASM) 터미널의 진입점.
// 렌더러(term)+PTY+복원+IME 는 renderer.ts(createGhosttyRenderer)가 소유한다 — 여기는 마운트
// 수명·포커스 코디네이션·명령 등록만 얇게 처리한다(xterm plugin-entry 와 같은 자리·같은 얇기).
import { createGhosttyRenderer } from "./renderer";
import {
  ensureSidecar,
  createFocusCoordinator,
  type FocusCoordinator,
  type TerminalRenderer,
  type PluginContext,
  type PluginViewContext,
  type Disposable,
} from "soksak-kit-terminal-common";

// per-view 마운트 상태 — 포커스 코디네이터(렌더러 준비 전 포커스 요청을 잡는다) + 렌더러 + io 핸들.
interface Mounted {
  focus: FocusCoordinator;
  renderer: TerminalRenderer | null;
  io: Disposable | null;
  disposed: boolean;
}
const mounts = new Map<string, Mounted>();

// 뷰 마운트 — 렌더러를 비동기 생성해 붙이고 io/포커스를 배선한다. 정리 함수를 반환한다.
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

  const m: Mounted = { focus: createFocusCoordinator(), renderer: null, io: null, disposed: false };
  mounts.set(viewId, m);

  void createGhosttyRenderer({
    app,
    viewId,
    cwd: vctx.restore?.cwd ?? vctx.root ?? undefined,
    initialCommand: vctx.command ?? undefined,
    onTitle: (t) => vctx.setTitle(t),
  })
    .then((r) => {
      if (m.disposed) {
        void r.dispose(); // 마운트 완료 전 unmount 됨 — 즉시 정리(그 사이 스폰된 PTY 를 닫는다)
        return;
      }
      m.renderer = r;
      container.appendChild(r.element);
      // 코어 substrate IO 등록 — term.read/term.send 가 이 pane 에 닿는다(키=viewId=paneId).
      m.io =
        app.pty?.registerIo?.(viewId, {
          readBuffer: (lines) => r.readBuffer(lines),
          sendInput: (data) => r.sendInput(data),
        }) ?? null;
      // 렌더러 준비 완료 — 대기 중이던 포커스 요청이 있으면 코디네이터가 적용한다(창전환 팔로우).
      m.focus.attach({ focus: () => r.focus(), prepareFocusTransfer: () => r.prepareFocusTransfer() });
      vctx.setStatus(null);
    })
    .catch((e: unknown) => {
      if (!m.disposed) vctx.setStatus({ code: "error", message: `엔진 초기화 실패: ${e}` });
    });

  return () => {
    m.disposed = true;
    m.focus.detach();
    m.io?.dispose();
    void m.renderer?.dispose();
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
      ctx.subscriptions.push(
        app.commands.register("ping", {
          description: "Load/engine check — returns the plugin id and engine (E2E).",
          message: () => "고스티 엔진이 응답합니다.",
          handler: () => ({ ok: true, plugin: "soksak-plugin-terminal-ghostty", engine: "ghostty" }),
        }),
      );
    }
  },
  deactivate() {
    for (const m of mounts.values()) void m.renderer?.dispose();
    mounts.clear();
  },
};
