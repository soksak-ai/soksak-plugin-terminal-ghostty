// ghostty-web 한글/CJK 조합 프리뷰 — 커서 위치·크기 픽셀 정합.
//
// 실기기 지문(2026-07-11, ime.trace)으로 확정된 사실:
//   - 이 경로(컨테이너 div 조합)에서는 WKWebView 가 표준 composition 이벤트를 정상 발화한다
//     (compositionstart → compositionupdate(data) → compositionend(data) → onData 1회).
//   - 문제는 위치·크기뿐: 브라우저는 조합 노드를 컨테이너 좌상단에 그리고, DOM div 프리뷰는
//     렌더러의 셀 기하(metrics.width/height/baseline)와 기준선이 어긋난다(실기기 라운드 3).
//
// 해법: 프리뷰를 렌더러와 동일 수식으로 그리는 미니 캔버스로 — 같은 metrics, 같은 baseline,
// 같은 폰트, dpr 스케일, 와이드(2셀) 폭 반영. 커서 셀 위에 겹친다(조합 = 삽입 예정 표시).
import type { Terminal } from "ghostty-web";

export interface PreeditHandle {
  dispose(): void;
}

interface RendererMetrics {
  width: number;
  height: number;
  baseline: number;
}

const isWide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xa960 && cp <= 0xa97f) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6);

const cellCount = (s: string): number => {
  let n = 0;
  for (const ch of s) n += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return n;
};

export function attachGhosttyPreedit(term: Terminal, host: HTMLElement): PreeditHandle {
  const target = term.element ?? host;

  // 조합 노드가 실제로 삽입되는 요소(tabindex 컨테이너 포함) 전부 무광·무레이아웃 처리.
  const focusables = new Set<HTMLElement>([target]);
  const tabbed = host.querySelector<HTMLElement>("[tabindex]");
  if (tabbed) focusables.add(tabbed);
  if (target.parentElement && target.parentElement !== host) focusables.add(target.parentElement);
  const prevStyles = new Map<HTMLElement, { fontSize: string; color: string; caret: string }>();
  for (const el of focusables) {
    prevStyles.set(el, { fontSize: el.style.fontSize, color: el.style.color, caret: el.style.caretColor });
    el.style.fontSize = "0px";
    el.style.color = "transparent";
    el.style.caretColor = "transparent";
  }

  // 프리뷰 = 미니 캔버스(렌더러와 동일 기하로 자가 렌더).
  const overlay = document.createElement("canvas");
  overlay.setAttribute("data-node", "ime-preedit");
  overlay.style.cssText = "position:absolute;z-index:3;pointer-events:none;display:none";
  host.appendChild(overlay);

  const rendererMetrics = (): RendererMetrics | null => {
    const r = term.renderer as unknown as { metrics?: RendererMetrics } | undefined;
    const m = r?.metrics;
    return m && m.width > 0 && m.height > 0 ? m : null;
  };

  const draw = (data: string): void => {
    const m = rendererMetrics();
    const canvasEl = (term.element ?? host).querySelector("canvas");
    if (!m || !canvasEl) return;
    const cRect = canvasEl.getBoundingClientRect();
    const hRect = host.getBoundingClientRect();
    const col = term.buffer.active.cursorX;
    const row = term.buffer.active.cursorY - term.getViewportY();
    const cells = Math.max(1, cellCount(data));
    const wCss = m.width * cells;
    const hCss = m.height;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(wCss * dpr);
    overlay.height = Math.round(hCss * dpr);
    overlay.style.width = `${wCss}px`;
    overlay.style.height = `${hCss}px`;
    overlay.style.left = `${cRect.left - hRect.left + col * m.width}px`;
    overlay.style.top = `${cRect.top - hRect.top + row * m.height}px`;
    const ctx = overlay.getContext("2d")!;
    ctx.scale(dpr, dpr);
    // 커서색 배경(커서 셀을 덮는다 — 조합이 커서 자리 삽입 예정임을 표시) + 배경색 글자.
    ctx.fillStyle = String(term.options.theme?.cursor ?? "#3b82f6");
    ctx.fillRect(0, 0, wCss, hCss);
    ctx.fillStyle = String(term.options.theme?.background ?? "#fff");
    ctx.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
    ctx.fillText(data, 0, m.baseline); // 렌더러와 동일: y = baseline
    // 조합 중 표기(언더라인) — 렌더러 underline 스타일과 동형(하단 15%).
    const ul = Math.max(2, Math.floor(hCss * 0.1));
    ctx.fillRect(0, hCss - ul, wCss, ul);
    overlay.style.display = "block";
  };

  let composing = false;
  const onStart = (): void => {
    composing = true;
  };
  const onUpdate = (e: Event): void => {
    if (!composing) return;
    const data = (e as CompositionEvent).data ?? "";
    if (!data) {
      overlay.style.display = "none";
      return;
    }
    draw(data);
  };
  const onEnd = (): void => {
    composing = false;
    overlay.style.display = "none";
  };

  target.addEventListener("compositionstart", onStart, true);
  target.addEventListener("compositionupdate", onUpdate, true);
  target.addEventListener("compositionend", onEnd, true);

  return {
    dispose() {
      target.removeEventListener("compositionstart", onStart, true);
      target.removeEventListener("compositionupdate", onUpdate, true);
      target.removeEventListener("compositionend", onEnd, true);
      overlay.remove();
      for (const [el, prev] of prevStyles) {
        el.style.fontSize = prev.fontSize;
        el.style.color = prev.color;
        el.style.caretColor = prev.caret;
      }
    },
  };
}
