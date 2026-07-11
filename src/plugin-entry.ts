// soksak-plugin-terminal-ghostty — Ghostty VT 엔진(WASM) 터미널.
// M0 스파이크: K1(WASM 단일번들)·K2(pty 왕복)·K3(버퍼 직렬화)·K5(fit) 실기기 판정용 최소 배선.
// PTY 는 코어 app.pty 단일 진실(P2) — 이 플러그인은 렌더러만 소유한다.
import { init, Terminal, FitAddon } from "ghostty-web";
import type { PluginContext, PluginViewContext, Disposable } from "./host";

// 플로우 컨트롤 — 5000B 처리 후 ACK(코어 pty.rs 가 짝).
const FLOW_ACK_SIZE = 5000;

interface Instance {
  ptyId: number | null;
  dispose: () => void;
}
const instances = new Map<string, Instance>();

// WASM 공유 인스턴스 init(1회) — ghostty-web 은 WASM 을 base64 data URL 로 자체 인라인하므로
// 경로 해석 0(P8). 실패는 mount 에서 status 로 표면화한다.
let initP: Promise<void> | null = null;
const ensureInit = (): Promise<void> => (initP ??= init());

function mountTerminal(container: HTMLElement, ctx: PluginContext, vctx: PluginViewContext): () => void {
  const app = ctx.app;
  const viewId = vctx.viewId;
  let disposed = false;
  const subs: Disposable[] = [];

  const cell = document.createElement("div");
  cell.setAttribute("data-node", "terminal");
  cell.style.cssText = "position:absolute;inset:0;overflow:hidden";
  container.style.position = "relative";
  container.appendChild(cell);

  if (!app.pty) {
    vctx.setStatus({ code: "error", message: "pty 권한/표면 없음" });
    return () => cell.remove();
  }
  if (!viewId) {
    vctx.setStatus({ code: "error", message: "콘텐츠 배치 전용 뷰" });
    return () => cell.remove();
  }
  vctx.setStatus({ code: "connecting" });

  const inst: Instance = {
    ptyId: null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const s of subs.splice(0)) s.dispose();
      if (inst.ptyId != null) void app.pty?.close(inst.ptyId);
      instances.delete(viewId);
      cell.remove();
    },
  };
  instances.set(viewId, inst);

  void (async () => {
    try {
      await ensureInit();
    } catch (e) {
      if (!disposed) vctx.setStatus({ code: "error", message: `엔진 초기화 실패: ${e}` });
      return;
    }
    if (disposed) return;

    // 테마 — 코어 발행 토큰만 소비(P7: 고스트 변수 금지). 실측 스냅샷 후 적용.
    const css = getComputedStyle(document.documentElement);
    const tok = (name: string): string => css.getPropertyValue(name).trim();
    const term = new Terminal({
      fontFamily: String(app.settings.get("appFontFamily") ?? "Menlo, monospace"),
      fontSize: Number(app.settings.get("appFontSize") ?? 13),
      theme: {
        background: tok("--bg") || "#111",
        foreground: tok("--fg") || "#eee",
        cursor: tok("--acc") || "#3b82f6",
        selectionBackground: tok("--accbg") || "#3b82f655",
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(cell);
    fit.fit();

    // ── PTY 배선(코어 단일 진실) ──
    const pty = app.pty!;
    const restoredCwd = vctx.restore?.cwd ?? undefined;
    const ptyId = await pty.spawn({
      cols: term.cols,
      rows: term.rows,
      cwd: restoredCwd ?? vctx.root ?? undefined,
      paneId: viewId,
    });
    if (disposed) {
      void pty.close(ptyId);
      return;
    }
    inst.ptyId = ptyId;

    // 출력: PTY → term. ACK 플로우 컨트롤(5000B 누적마다).
    let pendingAck = 0;
    subs.push(
      pty.onData(ptyId, (bytes) => {
        term.write(bytes, () => {
          pendingAck += bytes.byteLength;
          if (pendingAck >= FLOW_ACK_SIZE) {
            const n = pendingAck;
            pendingAck = 0;
            void pty.ack(ptyId, n);
          }
        });
      }),
    );
    // 입력: term → PTY.
    subs.push(term.onData((data) => void pty.write(ptyId, data)));
    // 리사이즈: 컨테이너 관찰 → fit → PTY SIGWINCH.
    const ro = new ResizeObserver(() => {
      fit.fit();
    });
    ro.observe(cell);
    subs.push({ dispose: () => ro.disconnect() });
    subs.push(
      term.onResize(({ cols, rows }) => void pty.resize(ptyId, cols, rows)),
    );
    // 제목: OSC 0/2 → 탭 제목(콘텐츠 사실 채널).
    subs.push(term.onTitleChange((t) => t && vctx.setTitle(t)));

    // ── 코어 substrate IO 등록 — term.read/term.send 가 이 pane 에 닿는다(K3) ──
    subs.push(
      pty.registerIo(viewId, {
        readBuffer: (lines) => {
          const buf = term.buffer.active;
          const total = buf.length;
          const want = Math.min(lines ?? total, total);
          const start = total - want;
          const out: string[] = [];
          for (let y = start; y < total; y++) {
            const line = buf.getLine(y);
            if (line) out.push(line.translateToString(true));
          }
          return out.join("\n").replace(/\n+$/, "");
        },
        sendInput: (data) => void pty.write(ptyId, data),
      }),
    );

    // 자동 실행 명령(에이전트 프로그램 채널) — spawn 직후 1회.
    if (vctx.command) void pty.write(ptyId, `${vctx.command}\r`);

    vctx.setStatus(null);
    term.focus();
  })();

  return inst.dispose;
}

export default {
  activate(ctx: PluginContext) {
    const app = ctx.app;
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
    for (const inst of instances.values()) inst.dispose();
    instances.clear();
  },
};
