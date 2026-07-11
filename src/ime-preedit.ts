// ghostty-web 한글/CJK 조합 프리뷰 — 커서 위치 정합.
//
// 실기기 지문(2026-07-11, ime.trace)으로 확정된 사실:
//   - 이 경로(컨테이너 div 조합)에서는 WKWebView 가 **표준 composition 이벤트를 정상 발화**한다
//     (compositionstart → compositionupdate(data) → compositionend(data) → onData 1회).
//     xterm 의 비표준화(WebKit bug 274700)는 textarea 특유였다 — 여기선 가드 불요.
//   - 문제는 위치뿐: 브라우저가 조합 중 텍스트 노드를 컨테이너 맨 앞(좌상단)에 삽입해 그린다.
//     (compositionend 시 ghostty-web 이 그 노드를 청소하고 onData 로 커밋 — 데이터는 무결.)
//
// 해법: 조합 텍스트는 우리가 커서 셀 위치에 오버레이로 그리고, 브라우저의 컨테이너 조합
// 노드는 font-size:0 + color:transparent 로 무광·무레이아웃 처리한다(캔버스는 무영향).
import type { Terminal } from "ghostty-web";

export interface PreeditHandle {
  dispose(): void;
}

export function attachGhosttyPreedit(term: Terminal, host: HTMLElement): PreeditHandle {
  const target = term.element ?? host;

  // 브라우저 조합 노드 무광화 — 컨테이너 직속 텍스트 노드만 영향(캔버스는 픽셀이라 무관).
  const prevFontSize = target.style.fontSize;
  const prevColor = target.style.color;
  const prevCaret = target.style.caretColor;
  target.style.fontSize = "0px";
  target.style.color = "transparent";
  target.style.caretColor = "transparent";

  // 프리뷰 오버레이 — 터미널과 같은 폰트/크기, 테마 토큰 소비(P7), 언더라인으로 조합 중임을 표기.
  const overlay = document.createElement("div");
  overlay.setAttribute("data-node", "ime-preedit");
  overlay.style.cssText =
    "position:absolute;z-index:3;pointer-events:none;display:none;white-space:pre;" +
    "text-decoration:underline;border-radius:2px";
  host.appendChild(overlay);

  const cellMetrics = (): { w: number; h: number } => {
    // 셀 크기 = 캔버스 논리 크기 / cols·rows. 캔버스가 아직 0 이면 폰트 근사.
    const el = term.element;
    const w = el && term.cols > 0 ? el.clientWidth / term.cols : 8;
    const h = el && term.rows > 0 ? el.clientHeight / term.rows : 17;
    return { w: w > 0 ? w : 8, h: h > 0 ? h : 17 };
  };

  const position = (): void => {
    const { w, h } = cellMetrics();
    const x = term.buffer.active.cursorX * w;
    const y = (term.buffer.active.cursorY - term.getViewportY()) * h;
    overlay.style.left = `${x}px`;
    overlay.style.top = `${y}px`;
    overlay.style.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
    overlay.style.lineHeight = `${h}px`;
    overlay.style.background = String(term.options.theme?.background ?? "var(--bg)");
    overlay.style.color = String(term.options.theme?.foreground ?? "var(--fg)");
  };

  let composing = false;
  const onStart = (): void => {
    composing = true;
    position();
  };
  const onUpdate = (e: Event): void => {
    if (!composing) return;
    const data = (e as CompositionEvent).data ?? "";
    if (!data) {
      overlay.style.display = "none";
      return;
    }
    position();
    overlay.textContent = data;
    overlay.style.display = "block";
  };
  const onEnd = (): void => {
    composing = false;
    overlay.style.display = "none";
    overlay.textContent = "";
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
      target.style.fontSize = prevFontSize;
      target.style.color = prevColor;
      target.style.caretColor = prevCaret;
    },
  };
}
