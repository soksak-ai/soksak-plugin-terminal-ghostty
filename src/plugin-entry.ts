// soksak-plugin-terminal-ghostty — Ghostty VT 엔진(WASM) 터미널의 진입점.
// 렌더러(term)+PTY+복원+IME 는 renderer.ts(createGhosttyRenderer)가 소유한다 — 여기는 마운트
// 수명·포커스 코디네이션·명령 등록만 얇게 처리한다(xterm plugin-entry 와 같은 자리·같은 얇기).
import { createGhosttyRenderer } from "./renderer";
import {
  ensureSidecar,
  createFocusCoordinator,
  createTerminalRegistry,
  registerTerminalCommands,
  createPaneSplitHost,
  createActivePaneProxy,
  type PaneSplitHost,
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
  splitHost: PaneSplitHost | null;
  io: Disposable | null;
  disposed: boolean;
}
const mounts = new Map<string, Mounted>();
// 활성 렌더러 레지스트리 — kit 공통 명령(send/clear/resume)이 대상을 해소한다.
const registry = createTerminalRegistry();

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

  const m: Mounted = {
    focus: createFocusCoordinator(),
    renderer: null,
    splitHost: null,
    io: null,
    disposed: false,
  };
  mounts.set(viewId, m);

  const cwd = vctx.restore?.cwd ?? vctx.root ?? undefined;
  const onTitle = (t: string): void => vctx.setTitle(t);
  const fail = (e: unknown): void => {
    if (!m.disposed) vctx.setStatus({ code: "error", message: `엔진 초기화 실패: ${e}` });
  };
  // 설정이 분할 방식을 정한다: "within-tab" = 뷰 내부를 pane 으로(kit split 호스트), 그 외 = 단일
  // 렌더러(탭분할은 코어 panel.split 이 담당). 기본은 "tab"(정상 경로 무손상).
  const withinTab = String(app.settings.get("splitMode") ?? "tab") === "within-tab";

  if (withinTab) {
    // 각 pane 은 자기 PTY(paneId=`${viewId}~n`). io/포커스는 활성 pane 에 위임. 첫 pane 만 initialCommand.
    let seq = 0;
    let first = true;
    void createPaneSplitHost({
      container,
      mintPaneId: () => `${viewId}~${seq++}`,
      createRenderer: async (paneId) => {
        const r = await createGhosttyRenderer({
          app,
          viewId: paneId,
          cwd,
          initialCommand: first ? vctx.command ?? undefined : undefined,
          onTitle,
        });
        first = false;
        return r;
      },
      onEmpty: () => vctx.setStatus({ code: "error", message: "빈 뷰 — 마지막 pane 이 닫혔습니다" }),
    })
      .then((h) => {
        if (m.disposed) {
          void h.dispose();
          return;
        }
        m.splitHost = h;
        m.io =
          app.pty?.registerIo?.(viewId, {
            readBuffer: (lines) => h.active()?.renderer.readBuffer(lines) ?? "",
            sendInput: (data) => h.active()?.renderer.sendInput(data),
          }) ?? null;
        m.focus.attach({
          focus: () => h.active()?.renderer.focus(),
          prepareFocusTransfer: () => h.active()?.renderer.prepareFocusTransfer(),
        });
        // 명령(send/clear/resume) 대상 레지스트리 — 위임 프록시 하나 등록(활성 pane 추종).
        registry.set(viewId, createActivePaneProxy(h));
        vctx.setStatus(null);
      })
      .catch(fail);
    return () => cleanup(m, viewId, container);
  }

  void createGhosttyRenderer({ app, viewId, cwd, initialCommand: vctx.command ?? undefined, onTitle })
    .then((r) => {
      if (m.disposed) {
        void r.dispose(); // 마운트 완료 전 unmount 됨 — 즉시 정리(그 사이 스폰된 PTY 를 닫는다)
        return;
      }
      m.renderer = r;
      registry.set(viewId, r);
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
    .catch(fail);

  return () => cleanup(m, viewId, container);
}

function cleanup(m: Mounted, viewId: string, container: HTMLElement): void {
  m.disposed = true;
  m.focus.detach();
  m.io?.dispose();
  void m.renderer?.dispose();
  void m.splitHost?.dispose();
  registry.delete(viewId);
  mounts.delete(viewId);
  container.replaceChildren();
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
      // split-pane — 뷰 내부를 pane 으로 쪼갠다(탭내 분할, splitMode=within-tab 인 뷰만 대상).
      ctx.subscriptions.push(
        app.commands.register("split-pane", {
          description:
            "Split the terminal view into an internal pane (within-tab split; requires splitMode=within-tab).",
          triggers: { ko: "터미널 탭내 분할 나누기" },
          params: {
            view: { type: "string", description: "Target view id (omit = first within-tab view)" },
            dir: { type: "string", description: "'right' (default) or 'down'" },
          },
          returns: "{ ok, viewId?, paneId? }",
          message: (d) => (d.ok ? `pane ${d.paneId} 을 분할했습니다.` : "분할 대상 없음"),
          handler: async (p) => {
            const viewId =
              typeof p.view === "string" && p.view
                ? p.view
                : [...mounts].find(([, mm]) => mm.splitHost)?.[0];
            const mm = viewId ? mounts.get(viewId) : undefined;
            if (!mm?.splitHost) {
              return { ok: false, code: "NO_TARGET", message: "no within-tab split host (set splitMode=within-tab)" };
            }
            const paneId = await mm.splitHost.split(p.dir === "down" ? "col" : "row");
            return { ok: true, viewId, paneId };
          },
        }),
      );
    }
  },
  deactivate() {
    for (const m of mounts.values()) {
      void m.renderer?.dispose();
      void m.splitHost?.dispose();
    }
    mounts.clear();
  },
};
