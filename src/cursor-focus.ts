// 포커스 in/out 커서 구분 — 터미널 관례: 포커스=채운 블록, 비포커스=중공(1px 테두리).
//
// ghostty-web 렌더러(renderCursor)는 focus 개념이 없다 — cursorStyle(block/underline/bar)만
// 분기하고 항상 채워 그린다(dist 판독으로 확정). 렌더러를 포크하지 않고 인스턴스의
// renderCursor 만 오버라이드한다(measureFont 런타임 교정과 동일한 문서화된 패턴).
// [임시] 상류가 focus-aware 커서를 제공하면 이 모듈을 제거한다.
import type { Terminal } from "ghostty-web";

export interface FocusCursorHandle {
  dispose(): void;
  /** 현재 판정 상태(진단용) */
  isFocused(): boolean;
  /** 최근 포커스 이벤트 로그(진단용, M0 임시) */
  trace(): string[];
}

interface RendererCursorSurface {
  renderCursor?: (col: number, row: number) => void;
  metrics?: { width: number; height: number };
  theme?: { cursor?: string };
  ctx?: CanvasRenderingContext2D;
  lastCursorPosition?: { x: number; y: number };
}

export function attachFocusCursor(term: Terminal, host: HTMLElement): FocusCursorHandle {
  const r = term.renderer as unknown as RendererCursorSurface | undefined;
  if (!r || typeof r.renderCursor !== "function")
    return { dispose() {}, isFocused: () => false, trace: () => ["no renderer"] };

  const original = r.renderCursor; // 프로토타입 메서드 — dispose 시 own property 삭제로 복원
  let focused = host.contains(document.activeElement);
  const log: string[] = [`init focused=${focused}`];
  const note = (m: string): void => {
    log.push(m);
    if (log.length > 40) log.splice(0, log.length - 40);
  };
  // 포커스 변경은 렌더러 dirty 상태에 없다 — 커서 픽셀이 다음 콘텐츠 변경까지 스테일(실측).
  // 렌더러 자신의 커서 이동 무효화 경로를 재사용한다: lastCursorPosition 불일치 →
  // 다음 프레임에 커서 행 renderLine(구 커서 지움) + renderCursor(신 상태). 폴링·강제 풀리드로 없음.
  const repaintCursor = (): void => {
    if (r.lastCursorPosition) r.lastCursorPosition = { x: -1, y: -1 };
  };

  r.renderCursor = function (col: number, row: number): void {
    if (focused) {
      original.call(r, col, row);
      return;
    }
    const m = r.metrics;
    const ctx = r.ctx;
    if (!m || !ctx) return;
    ctx.strokeStyle = r.theme?.cursor ?? "#3b82f6";
    ctx.lineWidth = 1;
    // 0.5 오프셋: 1px stroke 를 물리 격자에 정렬(블록 커서와 같은 셀 경계).
    ctx.strokeRect(col * m.width + 0.5, row * m.height + 0.5, m.width - 1, m.height - 1);
  };

  // 렌더루프는 상시 rAF 라 상태만 바꾸면 다음 프레임에 반영된다(추가 무효화 불요).
  const onFocusIn = (e: Event): void => {
    focused = true;
    note(`focusin <- ${(e.target as HTMLElement)?.tagName}`);
    repaintCursor();
  };
  const onFocusOut = (e: Event): void => {
    focused = false;
    note(`focusout <- ${(e.target as HTMLElement)?.tagName}`);
    repaintCursor();
  };
  // WKWebView 는 네이티브 윈도가 키를 잃어도 DOM activeElement 를 유지할 수 있다 —
  // window blur/focus 도 함께 본다.
  const onWinBlur = (): void => {
    focused = false;
    note("window blur");
    repaintCursor();
  };
  const onWinFocus = (): void => {
    focused = host.contains(document.activeElement);
    note(`window focus -> ${focused}`);
    repaintCursor();
  };
  host.addEventListener("focusin", onFocusIn);
  host.addEventListener("focusout", onFocusOut);
  window.addEventListener("blur", onWinBlur);
  window.addEventListener("focus", onWinFocus);

  return {
    dispose() {
      host.removeEventListener("focusin", onFocusIn);
      host.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("blur", onWinBlur);
      window.removeEventListener("focus", onWinFocus);
      delete (r as { renderCursor?: unknown }).renderCursor; // 프로토타입 메서드로 복원
    },
    isFocused: () => focused,
    trace: () => [...log],
  };
}
