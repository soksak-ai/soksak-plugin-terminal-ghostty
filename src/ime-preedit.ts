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

  // 조합 노드가 실제로 삽입되는 요소 = InputHandler 의 컨테이너(tabindex 부여됨).
  // term.element 와 다를 수 있어 런타임에서 발견해 무광화한다(실기기: element 만 처리 시 유령 잔존).
  const focusables = new Set<HTMLElement>([target]);
  const tabbed = host.querySelector<HTMLElement>('[tabindex]');
  if (tabbed) focusables.add(tabbed);
  if (target.parentElement && target.parentElement !== host) focusables.add(target.parentElement);
  const prevStyles = new Map<HTMLElement, { fontSize: string; color: string; caret: string }>();
  for (const el of focusables) {
    prevStyles.set(el, { fontSize: el.style.fontSize, color: el.style.color, caret: el.style.caretColor });
    el.style.fontSize = "0px";
    el.style.color = "transparent";
    el.style.caretColor = "transparent";
  }

  // 프리뷰 오버레이 — 터미널과 같은 폰트/크기, 테마 토큰 소비(P7), 언더라인으로 조합 중임을 표기.
  const overlay = document.createElement("div");
  overlay.setAttribute("data-node", "ime-preedit");
  overlay.style.cssText =
    "position:absolute;z-index:3;pointer-events:none;display:none;white-space:pre;" +
    "text-decoration:underline;border-radius:2px";
  host.appendChild(overlay);

  // 격자 기하 = 캔버스 실측(getBoundingClientRect). element 는 패딩·여백이 섞여 어긋난다(실기기).
  const position = (): void => {
    const canvas = (term.element ?? host).querySelector("canvas");
    const cRect = (canvas ?? term.element ?? host).getBoundingClientRect();
    const hRect = host.getBoundingClientRect();
    const w = term.cols > 0 ? cRect.width / term.cols : 8;
    const h = term.rows > 0 ? cRect.height / term.rows : 17;
    const col = term.buffer.active.cursorX;
    const row = term.buffer.active.cursorY - term.getViewportY();
    // 커서 셀 "위"에 겹친다 — 배경을 채워 아래의 커서 블록을 덮는다(조합 = 커서 자리 삽입 예정 표시).
    overlay.style.left = `${cRect.left - hRect.left + col * w}px`;
    overlay.style.top = `${cRect.top - hRect.top + row * h}px`;
    overlay.style.minWidth = `${w}px`;
    overlay.style.height = `${h}px`;
    overlay.style.font = `${term.options.fontSize}px ${term.options.fontFamily}`;
    overlay.style.lineHeight = `${h}px`;
    overlay.style.background = String(term.options.theme?.cursor ?? "var(--acc)");
    overlay.style.color = String(term.options.theme?.background ?? "var(--bg)");
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
      for (const [el, prev] of prevStyles) {
        el.style.fontSize = prev.fontSize;
        el.style.color = prev.color;
        el.style.caretColor = prev.caret;
      }
    },
  };
}
