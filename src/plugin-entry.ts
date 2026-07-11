// soksak-plugin-terminal-ghostty — Ghostty VT 엔진(WASM) 터미널.
// M0 스파이크: K1(WASM 단일번들)·K2(pty 왕복)·K3(버퍼 직렬화)·K5(fit) 실기기 판정용 최소 배선.
// PTY 는 코어 app.pty 단일 진실(P2) — 이 플러그인은 렌더러만 소유한다.
import { init, Terminal, FitAddon } from "ghostty-web";
import { attachGhosttyPreedit } from "./ime-preedit";
import { attachFocusCursor } from "./cursor-focus";
import { openWithoutImplicitFocus } from "./focus-contract";
import type { PluginContext, PluginViewContext, Disposable } from "./host";

// 플로우 컨트롤 — 5000B 처리 후 ACK(코어 pty.rs 가 짝).
const FLOW_ACK_SIZE = 5000;

interface Instance {
  ptyId: number | null;
  term?: Terminal;
  ready: boolean;
  preedit?: import("./ime-preedit").PreeditHandle;
  focusRequest?: { signal: AbortSignal };
  focusCursor?: import("./cursor-focus").FocusCursorHandle;
  dispose: () => void;
}
const instances = new Map<string, Instance>();
// M0 진단 — write 경로 계측(스파이크 전용, 게이트 판정 후 제거).
const DIAG = { writes: 0, writeBytes: 0, writeCb: 0, lastErr: "", bufferLen: -1, cols: 0, rows: 0, wasm: false, onResizeFired: 0, ptyResizeSent: 0 };
// IME 이벤트 지문(실기기 채집 — ime.trace 로 회수). 링버퍼. 이 인스턴스 소유 DOM 이벤트만 기록한다.
const IME_TRACE: string[] = [];
const traceLine = (line: string): void => { IME_TRACE.push(line); if (IME_TRACE.length > 160) IME_TRACE.splice(0, IME_TRACE.length - 160); };

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
    // [M0 진단 — 자기 element 스코프, 공유 오염 없음] 이 인스턴스의 element.focus() 호출자를 스택으로
    // 잡는다: xterm 클릭 시 ghostty 가 스스로 재포커스하는(바운스) 범인 규명용. 판정 후 제거.
    if (term.element) {
      const el = term.element as HTMLElement;
      const rawElFocus = el.focus.bind(el);
      el.focus = ((...args: unknown[]) => {
        const stack = (new Error().stack ?? "").split("\n").slice(1, 6).map((s) => s.trim().replace(/^at /, "")).join(" <- ");
        traceLine(`[${viewId}] element.focus() BY: ${stack}`);
        return (rawElFocus as (...a: unknown[]) => void)(...args);
      }) as typeof el.focus;
    }
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
        DIAG.writes += 1;
        DIAG.writeBytes += bytes.byteLength;
        try {
          // ghostty-web 의 write 는 동기 파싱(wasmTerm.write 즉시 반영 — 프로브 실측)이고,
          // 콜백은 렌더 rAF 에 묶인다. ACK 를 콜백에 걸면 가려진 창(rAF 정지)에서 5000B 후
          // PTY 가 영구 stall — 파싱 완료 기준인 동기 ACK 가 옳다(xterm 은 비동기 파서라 콜백).
          term.write(bytes, () => {
            DIAG.writeCb += 1; // 렌더 rAF 생존 관측용(진단)
          });
          pendingAck += bytes.byteLength;
          if (pendingAck >= FLOW_ACK_SIZE) {
            const n = pendingAck;
            pendingAck = 0;
            void pty.ack(ptyId, n);
          }
        } catch (e) {
          DIAG.lastErr = String(e);
        }
        DIAG.bufferLen = term.buffer.active.length;
        DIAG.cols = term.cols;
        DIAG.rows = term.rows;
        DIAG.wasm = !!term.wasmTerm;
      }),
    );
    // 입력: term → PTY.
    subs.push(term.onData((data) => void pty.write(ptyId, data)));
    // 한글 IME — ghostty-web 은 컨테이너 div 가 조합을 직접 받는다(브라우저가 조합 텍스트
    // 노드를 컨테이너에 삽입 → 좌상단 표시의 원인; compositionend 가 노드 청소 + onData 커밋).
    // 올바른 가드 설계를 위해 원조 애드온과 같은 방법론: 실기기 이벤트 지문을 먼저 채집한다.
    // (M0 임시 — ime.trace 커맨드로 회수, 판정 후 제거)
    const traceTarget = term.element ?? cell;
    const tag = viewId; // 인스턴스 식별 — 어느 터미널의 이벤트인지 구분(멀티 인스턴스 필수)
    const push = (line: string): void => traceLine(`[${tag}] ${line}`);
    const trace = (kind: string) => (e: Event) => {
      const ie = e as InputEvent & KeyboardEvent & CompositionEvent;
      push(
        `${kind}${ie.inputType ? ":" + ie.inputType : ""}${ie.key ? " key=" + ie.key : ""}${ie.keyCode ? " kc=" + ie.keyCode : ""}${"data" in ie && ie.data != null ? " data=" + JSON.stringify(ie.data) : ""}${ie.isComposing ? " composing" : ""}`,
      );
    };
    for (const ev of ["keydown", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]) {
      const h = trace(ev);
      traceTarget.addEventListener(ev, h, true);
      subs.push({ dispose: () => traceTarget.removeEventListener(ev, h, true) });
    }
    subs.push(term.onData((d) => push(`onData ${JSON.stringify(d)}`)));
    // 포커스/포인터 흐름 지문(조합 중 클릭 삼킴 진단) — 대상 요소 식별자 포함.
    const nodeDesc = (n: EventTarget | null): string => {
      const el = n as HTMLElement | null;
      if (!el || !el.tagName) return String(n);
      const dn = el.getAttribute?.("data-node");
      const cls = el.className ? "." + String(el.className).split(" ").slice(0, 1).join("") : "";
      return `${el.tagName}${dn ? "[" + dn + "]" : ""}${cls}`;
    };
    // focusout/in 은 term.element 에서만 유효 — 이 인스턴스 소유 이벤트만 기록됨.
    const foTrace = (e: Event) => push(`focusout -> related=${nodeDesc((e as FocusEvent).relatedTarget)}`);
    const fiTrace = (e: Event) => push(`focusin <- ${nodeDesc(e.target)}`);
    traceTarget.addEventListener("focusout", foTrace, true);
    traceTarget.addEventListener("focusin", fiTrace, true);
    subs.push({ dispose: () => traceTarget.removeEventListener("focusout", foTrace, true) });
    subs.push({ dispose: () => traceTarget.removeEventListener("focusin", fiTrace, true) });
    // 조합 프리뷰 커서 정합(실기기 지문 기반 — ime-preedit.ts 머리 주석 참조).
    const preedit = attachGhosttyPreedit(term, cell);
    inst.preedit = preedit;
    subs.push({ dispose: () => preedit.dispose() });
    // 포커스 in/out 커서 구분(비포커스=중공) — cursor-focus.ts 머리 주석 참조.
    const focusCursor = attachFocusCursor(term, cell);
    subs.push({ dispose: () => focusCursor.dispose() });
    inst.focusCursor = focusCursor;
    // 리사이즈: 컨테이너 관찰 → fit → PTY SIGWINCH.
    const ro = new ResizeObserver(() => {
      fit.fit();
    });
    ro.observe(cell);
    subs.push({ dispose: () => ro.disconnect() });
    subs.push(
      term.onResize(({ cols, rows }) => {
        DIAG.onResizeFired += 1;
        DIAG.ptyResizeSent += 1;
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
        app.commands.register("diag", {
          description: "M0 spike diagnostics — write-path counters + direct probe (temporary).",
          params: { paneId: { type: "string", description: "target pane (viewId)" } },
          message: () => "진단 스냅샷입니다.",
          handler: (p) => {
            const want = typeof p.paneId === "string" ? (p.paneId as string) : null;
            const inst = want ? instances.get(want) : [...instances.values()].find((i) => i.term);
            let probe: Record<string, unknown> = {};
            if (inst?.term) {
              const t = inst.term;
              try {
                t.write("PROBE_XYZ\r\n");
                const lines: string[] = [];
                for (let y = 0; y < Math.min(6, t.buffer.active.length); y++) {
                  lines.push(t.buffer.active.getLine(y)?.translateToString(true) ?? "<null>");
                }
                probe = {
                  probeLines: lines,
                  cursorY: (t.buffer.active as unknown as { cursorY?: number }).cursorY,
                  viewportY: t.viewportY,
                  elemSize: t.element ? `${t.element.clientWidth}x${t.element.clientHeight}` : "no-elem",
                };
              } catch (e) {
                probe = { probeErr: String(e) };
              }
            }
            return { ok: true, ...DIAG, ...probe };
          },
        }),
      );
      ctx.subscriptions.push(
        app.commands.register("ime.probe", {
          description: "M0: synthetic composition probe - draws the preedit and returns geometry diff vs cursor (temporary). phase=show keeps the preview on screen for capture; phase=hide ends it.",
          params: { paneId: { type: "string" }, text: { type: "string" }, phase: { type: "string" }, selector: { type: "string" } },
          message: () => "프리에딧 기하 스냅샷입니다.",
          handler: (p) => {
            const want = typeof p.paneId === "string" ? (p.paneId as string) : null;
            const inst = want ? instances.get(want) : [...instances.values()].find((i) => i.term);
            const t = inst?.term;
            if (!t?.element) return { ok: false, error: "no terminal" };
            const target = t.element;
            const text = String(p.text ?? "한");
            const phase = String(p.phase ?? "pulse");
            if (phase === "hide") {
              target.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
              return { ok: true, phase };
            }
            if (phase === "clickother") {
              // 이 문서 안의 다른 요소(예: xterm textarea/canvas)를 실제 클릭 시퀀스로 친다 —
              // 바운스 자가 재현용. 합성 mousedown 도 JS 핸들러(xterm 의 textarea.focus)는 발동한다.
              const sel = String(p.selector ?? ".xterm-helper-textarea");
              const other = document.querySelector(sel) as HTMLElement | null;
              if (!other) return { ok: false, error: `no element: ${sel}` };
              const r = other.getBoundingClientRect();
              const cx = r.left + Math.max(1, r.width / 2), cy = r.top + Math.max(1, r.height / 2);
              const before = document.activeElement === target || target.contains(document.activeElement);
              for (const type of ["mousedown", "mouseup", "click"]) {
                other.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: cx, clientY: cy }));
              }
              return { ok: true, phase, selector: sel, terminalFocusedBefore: before };
            }
            if (phase === "clickcanvas") {
              // 실제 클릭 경로 재현: 대상 인스턴스 canvas 에 mousedown/mouseup/click 디스패치
              // (ghostty-web canvas 핸들러: preventDefault + textarea.focus → parentElement.focus).
              const canvas = t.element?.querySelector("canvas") as HTMLElement | null;
              if (!canvas) return { ok: false, error: "no canvas" };
              const r = canvas.getBoundingClientRect();
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              for (const type of ["mousedown", "mouseup", "click"]) {
                canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: cx, clientY: cy }));
              }
              return { ok: true, phase, activeAfter: document.activeElement === target || target.contains(document.activeElement) };
            }
            if (phase === "domfocus") {
              // 실제 DOM 포커스 이동(클릭 대신) — 대상 패널을 focus 하면 이전 패널은 진짜 focusout 을 받는다.
              target.focus();
              return { ok: true, phase, active: document.activeElement === target };
            }
            if (phase === "focusin" || phase === "focusout") {
              // 포커스 커서 경로 검증(cursor-focus.ts) — host 리스너까지 버블.
              target.dispatchEvent(new FocusEvent(phase, { bubbles: true }));
              return { ok: true, phase, focused: inst?.focusCursor?.isFocused(), trace: inst?.focusCursor?.trace() };
            }
            if (phase === "topology") {
              // 이 webview 의 DOM 구성 조사 — chrome/xterm/ghostty 가 같은 문서에 있나(webview 경계 확정).
              const doc = document;
              const count = (sel: string) => doc.querySelectorAll(sel).length;
              return {
                ok: true,
                phase,
                url: location.href,
                title: doc.title,
                ghosttyCells: count('[data-node="terminal"][data-node]'),
                allTerminalNodes: count('[data-node="terminal"]'),
                xtermCanvas: count(".xterm, .xterm-screen, .xterm-viewport"),
                chromeTabStrip: count('[data-node*="tab"], [class*="tab-strip"], [class*="TabStrip"]'),
                sidebar: count('[class*="sidebar"], [class*="Sidebar"]'),
                bodyChildren: doc.body?.children.length ?? -1,
                sampleDataNodes: [...doc.querySelectorAll("[data-node]")].slice(0, 12).map((e) => (e as HTMLElement).getAttribute("data-node")),
              };
            }
            if (phase === "click-away") {
              // 배선 검증: 조합 활성 상태에서 터미널 밖 pointerdown → 조합 요소가 blur 되는가.
              // (WebKit 네이티브 커밋-삼킴은 synthetic 으로 재현 불가 — 이건 우리 방어의 발화만 확인)
              target.focus();
              target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
              target.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한", bubbles: true }));
              const beforeActive = document.activeElement === target || target.contains(document.activeElement);
              document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
              const afterActive = document.activeElement === target || target.contains(document.activeElement);
              target.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
              return { ok: true, phase, terminalFocusedBeforeClick: beforeActive, terminalFocusedAfterClick: afterActive, released: beforeActive && !afterActive };
            }
            if (phase === "focus-state") {
              const ae = document.activeElement as HTMLElement | null;
              const desc = (el: HTMLElement | null): string =>
                el ? `${el.tagName}${el.getAttribute("data-node") ? "[" + el.getAttribute("data-node") + "]" : ""}${el.className ? "." + String(el.className).split(" ").slice(0, 2).join(".") : ""}` : "null";
              return {
                ok: true,
                phase,
                focused: inst?.focusCursor?.isFocused(),
                trace: inst?.focusCursor?.trace(),
                activeElement: desc(ae),
                isTerminalFocused: t.element === ae || t.element?.contains(ae),
              };
            }
            target.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
            target.dispatchEvent(new CompositionEvent("compositionupdate", { data: text, bubbles: true }));
            const diag = (window as unknown as Record<string, unknown>).__ghosttyPreeditDiag ?? null;
            if (phase !== "show") target.dispatchEvent(new CompositionEvent("compositionend", { data: "", bubbles: true }));
            return { ok: true, phase, diag };
          },
        }),
      );
      ctx.subscriptions.push(
        app.commands.register("ime.trace", {
          description: "M0 IME ground-truth trace — event fingerprint ring buffer (temporary). clear=true empties the buffer for a clean capture.",
          params: { clear: { type: "boolean" } },
          message: () => "IME 이벤트 지문입니다.",
          handler: (p) => {
            if (p?.clear) { IME_TRACE.splice(0, IME_TRACE.length); return { ok: true, cleared: true }; }
            return { ok: true, trace: IME_TRACE.slice(-140) };
          },
        }),
      );
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
