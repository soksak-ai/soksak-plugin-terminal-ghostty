// soksak-plugin-terminal-ghostty — Ghostty VT 엔진(WASM) 터미널.
// M0 스파이크: K1(WASM 단일번들)·K2(pty 왕복)·K3(버퍼 직렬화)·K5(fit) 실기기 판정용 최소 배선.
// PTY 는 코어 app.pty 단일 진실(P2) — 이 플러그인은 렌더러만 소유한다.
import { init, Terminal, FitAddon } from "ghostty-web";
import { attachGhosttyPreedit } from "./ime-preedit";
import { attachFocusCursor } from "./cursor-focus";
import { openWithoutImplicitFocus } from "./focus-contract";
import { ensureSidecar, orchestrateRestore, ensureSession } from "./restore";
import type { PluginContext, PluginViewContext, Disposable } from "./host";

// 플로우 컨트롤 — 5000B 처리 후 ACK(코어 pty.rs 가 짝).
const FLOW_ACK_SIZE = 5000;

interface Instance {
  ptyId: number | null;
  term?: Terminal;
  ready: boolean;
  preedit?: import("./ime-preedit").PreeditHandle;
  focusRequest?: { signal: AbortSignal };
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
    ready: false,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const s of subs.splice(0)) s.dispose();
      if (inst.ptyId != null) void app.pty?.close(inst.ptyId);
      instances.delete(viewId);
      inst.ready = false;
      inst.focusRequest = undefined;
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

    // 테마 — 코어 발행 토큰만 소비(P7: 고스트 변수 금지). 스냅샷 함수 + 라이브 추종(아래).
    const themeNow = () => {
      const css = getComputedStyle(document.documentElement);
      const tok = (name: string): string => css.getPropertyValue(name).trim();
      return {
        background: tok("--bg") || "#111",
        foreground: tok("--fg") || "#eee",
        cursor: tok("--acc") || "#3b82f6",
        selectionBackground: tok("--accbg") || "#3b82f655",
      };
    };
    const term = new Terminal({
      fontFamily: String(app.settings.get("appFontFamily") ?? "Menlo, monospace"),
      fontSize: Number(app.settings.get("appFontSize") ?? 13),
      theme: themeNow(),
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    openWithoutImplicitFocus(term, cell);
    inst.term = term;
    // [임시 교정 — 상류 결함] ghostty-web CanvasRenderer.measureFont 가 "M" 잉크 박스
    // (actualBoundingBox*)로 행 높이·기준선을 잡는다 → 디센더 없는 "M" 기준이라 행이 과소하고,
    // 잉크가 더 높은 글리프(한글·숫자)가 셀 상단에 붙어 커서 블록만 아래로 처져 보인다(실기기).
    // 표준 폰트 박스(fontBoundingBox*)로 교체하고 remeasureFont(공개 API)로 재계산한다.
    // 제거 조건: 상류(coder/ghostty-web)가 fontBoundingBox 기반 측정을 수용하면 삭제.
    {
      const r = term.renderer as unknown as {
        measureFont?: () => { width: number; height: number; baseline: number };
        remeasureFont?: () => void;
      } | undefined;
      if (r?.measureFont && r.remeasureFont) {
        const fontPx = Number(term.options.fontSize ?? 13);
        const family = String(term.options.fontFamily ?? "monospace");
        r.measureFont = () => {
          const c = document.createElement("canvas").getContext("2d")!;
          c.font = `${fontPx}px ${family}`;
          const m = c.measureText("M");
          const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || fontPx * 0.8;
          const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || fontPx * 0.2;
          return {
            width: Math.ceil(m.width),
            height: Math.ceil(ascent + descent),
            baseline: Math.ceil(ascent),
          };
        };
        r.remeasureFont();
      }
    }
    fit.fit();
    // 앱 테마 라이브 추종 — documentElement 의 테마 계약(data-* + :root 변수) 변화를 관찰해
    // 렌더러에 재적용한다(폴링 없음).
    const mo = new MutationObserver(() => {
      term.renderer?.setTheme(themeNow());
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-theme-mode", "style", "class"] });
    subs.push({ dispose: () => mo.disconnect() });

    // ── 화면 복원 오케스트레이션(스폰 전) — 이 플러그인이 복원을 소유한다 ──
    // warm=사이드카 rehydrate→ghostty 페인트→from_seq, cold=봉인 블롭→페인트+소실 고지→'none',
    // fresh=코어 기본. spawn 전에 그린다(warm 은 uptoSeq 좌표, cold 는 신선 셸 출력 전에 페인트).
    // ghostty 는 명령-블록 floor 가 없어 painted 는 쓰지 않는다 — replay 만 소비한다.
    const outcome = await orchestrateRestore(app, viewId, (d) => term.write(d));
    if (disposed) return;

    // ── PTY 배선(코어 단일 진실) ──
    const pty = app.pty!;
    const restoredCwd = vctx.restore?.cwd ?? undefined;
    const ptyId = await pty.spawn({
      cols: term.cols,
      rows: term.rows,
      cwd: restoredCwd ?? vctx.root ?? undefined,
      paneId: viewId,
      replay: outcome.replay,
    });
    if (disposed) {
      void pty.close(ptyId);
      return;
    }
    inst.ptyId = ptyId;
    // [복원 렌더 플러시 불변식] 복원 페인트(rehydrate/cold)가 렌더러 초기 패스 전에 write 되면
    // 버퍼는 차나 픽셀이 백지로 남는다(ghostty-web canvas 초기화 타이밍). 렌더러 준비 후(rAF)
    // remeasureFont(공개 API — 전체 재렌더 강제)로 버퍼를 픽셀로 플러시한다 — "복원 페인트는
    // 렌더 플러시로 끝난다". 폴링/sleep 아님(단발 rAF).
    if (outcome.painted) {
      requestAnimationFrame(() => {
        if (disposed) return;
        try {
          (term.renderer as unknown as { remeasureFont?: () => void } | undefined)?.remeasureFont?.();
        } catch {
          /* 렌더러 미준비 — 다음 write 가 그린다 */
        }
      });
    }
    // 사이드카가 이 세션을 구독하게 한다 — 부팅 후 태어난 세션의 tee 를 근접-birth 에 잡아
    // 다음 재시작의 warm 복원 토대가 된다. 유계 재시도(사이드카 스폰 비동기), best-effort.
    void ensureSession(app, viewId, term.cols, term.rows);

    // 출력: PTY → term. ACK 플로우 컨트롤(5000B 누적마다).
    let pendingAck = 0;
    subs.push(
      pty.onData(ptyId, (bytes) => {
        // ghostty-web 의 write 는 동기 파싱(wasmTerm.write 즉시 반영)이고, 콜백은 렌더 rAF 에
        // 묶인다. ACK 를 콜백에 걸면 가려진 창(rAF 정지)에서 5000B 후 PTY 가 영구 stall — 파싱
        // 완료 기준인 동기 ACK 가 옳다(xterm 은 비동기 파서라 콜백).
        term.write(bytes);
        pendingAck += bytes.byteLength;
        if (pendingAck >= FLOW_ACK_SIZE) {
          const n = pendingAck;
          pendingAck = 0;
          void pty.ack(ptyId, n);
        }
      }),
    );
    // 입력: term → PTY.
    subs.push(term.onData((data) => void pty.write(ptyId, data)));
    // 조합 프리뷰 커서 정합(실기기 지문 기반 — ime-preedit.ts 머리 주석 참조).
    const preedit = attachGhosttyPreedit(term, cell);
    inst.preedit = preedit;
    subs.push({ dispose: () => preedit.dispose() });
    // 포커스 in/out 커서 구분(비포커스=중공) — cursor-focus.ts 머리 주석 참조.
    const focusCursor = attachFocusCursor(term, cell);
    subs.push({ dispose: () => focusCursor.dispose() });
    // 리사이즈: 컨테이너 관찰 → fit → PTY SIGWINCH.
    const ro = new ResizeObserver(() => {
      fit.fit();
    });
    ro.observe(cell);
    subs.push({ dispose: () => ro.disconnect() });
    subs.push(
      term.onResize(({ cols, rows }) => {
        void pty.resize(ptyId, cols, rows);
      }),
    );
    // 제목: OSC 0/2 → 탭 제목(콘텐츠 사실 채널).
    subs.push(term.onTitleChange((t) => t && vctx.setTitle(t)));

    // ── 코어 substrate IO 등록 — term.read/term.send 가 이 pane 에 닿는다(K3) ──
    subs.push(
      pty.registerIo(viewId, {
        readBuffer: (lines) => {
          // buffer.length 는 rows+스크롤백 전체(빈 꼬리 포함) — 끝에서 읽으면 빈 줄만 나온다(실측).
          // 전체를 읽어 트레일링 빈 줄을 지운 "실사용 영역"의 마지막 N줄을 반환한다(readBuffer 계약).
          const buf = term.buffer.active;
          const all: string[] = [];
          for (let y = 0; y < buf.length; y++) {
            all.push(buf.getLine(y)?.translateToString(true) ?? "");
          }
          let end = all.length;
          while (end > 0 && all[end - 1] === "") end--;
          const used = all.slice(0, end);
          return (lines ? used.slice(-lines) : used).join("\n");
        },
        sendInput: (data) => void pty.write(ptyId, data),
      }),
    );

    // 자동 실행 명령(에이전트 프로그램 채널) — spawn 직후 1회.
    if (vctx.command) void pty.write(ptyId, `${vctx.command}\r`);

    inst.ready = true;
    const queuedFocus = inst.focusRequest;
    inst.focusRequest = undefined;
    if (
      queuedFocus &&
      !queuedFocus.signal.aborted &&
      !cell.contains(document.activeElement)
    ) {
      term.focus();
    }
    vctx.setStatus(null);
  })();

  return inst.dispose;
}

export default {
  activate(ctx: PluginContext) {
    const app = ctx.app;
    // 생존 서비스 사이드카(터미널 미러 복원)를 스폰한다 — detached 로 앱 종료를 넘어 살고,
    // 싱글턴 프로브가 중복을 흡수한다(xterm 과 같은 계약·같은 유닛 terminal-alacritty 공유).
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
            if (!vctx.viewId) return;
            instances.get(vctx.viewId)?.preedit?.prepareFocusTransfer();
          },
          focus(_container, vctx, request) {
            if (!vctx.viewId || request.signal.aborted) return;
            const inst = instances.get(vctx.viewId);
            if (!inst) return;
            inst.focusRequest = request;
            if (!inst.term || !inst.ready) return;
            inst.focusRequest = undefined;
            inst.term.focus();
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
