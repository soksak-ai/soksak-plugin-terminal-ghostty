// ghostty-web 한글/CJK 조합 프리뷰 — 커서 위치·크기 픽셀 정합.
//
// 실기기 지문(2026-07-11, ime.trace)으로 확정된 사실:
//   - 이 경로(컨테이너 div 조합)에서는 WKWebView 가 표준 composition 이벤트를 정상 발화한다
//     (compositionstart → compositionupdate(data) → compositionend(data) → onData 1회).
//   - 문제는 위치·크기뿐: 브라우저는 조합 노드를 컨테이너 좌상단에 그리고, DOM div 프리뷰는
//     렌더러의 셀 기하(metrics.width/height/baseline)와 기준선이 어긋난다(실기기 라운드 3).
//
// 해법: 프리뷰를 렌더러와 동일 수식으로 그리는 미니 캔버스로 — 같은 metrics, 같은 baseline,
// 같은 폰트, dpr 스케일. 박스 폭은 글리프 실측 폭(measureText advance)에 맞추되(사용자 확정:
// 격자 2셀 폭은 글자보다 넓어 보임), 커서 블록(1셀)을 항상 덮도록 최소 1셀을 보장한다.
import type { Terminal } from "ghostty-web";

export interface PreeditHandle {
  dispose(): void;
}

interface RendererMetrics {
  width: number;
  height: number;
  baseline: number;
}

// 렌더러가 draw 에 실제 사용하는 필드들 — term.options 가 아니라 이것이 단일 진실.
// (renderCellText: ctx.font = `${fontSize}px ${fontFamily}` / renderCursor: theme.cursor)
interface RendererTruth {
  metrics?: RendererMetrics;
  fontSize?: number;
  fontFamily?: string;
  theme?: { cursor?: string; background?: string };
}

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

  const renderer = (): RendererTruth | undefined => term.renderer as unknown as RendererTruth | undefined;

  const draw = (data: string): void => {
    const r = renderer();
    const m = r?.metrics;
    const canvasEl = (term.element ?? host).querySelector("canvas");
    if (!m || !(m.width > 0) || !(m.height > 0) || !canvasEl) return;
    const cRect = canvasEl.getBoundingClientRect();
    const hRect = host.getBoundingClientRect();
    const col = term.buffer.active.cursorX;
    const row = term.buffer.active.cursorY - term.getViewportY();
    const font = `${r?.fontSize ?? term.options.fontSize}px ${r?.fontFamily ?? term.options.fontFamily}`;
    const ctx = overlay.getContext("2d")!;
    // 박스 폭 = 글리프 실측 폭(글자에 맞춤, 사용자 확정). 커서 블록(1셀)은 항상 덮는다.
    // 캔버스 리사이즈가 ctx 상태를 리셋하므로 측정을 먼저 한다.
    ctx.font = font;
    const advance = ctx.measureText(data).width;
    const wCss = Math.max(m.width, Math.ceil(advance));
    const hCss = m.height;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.round(wCss * dpr);
    overlay.height = Math.round(hCss * dpr);
    overlay.style.width = `${wCss}px`;
    overlay.style.height = `${hCss}px`;
    overlay.style.left = `${cRect.left - hRect.left + col * m.width}px`;
    overlay.style.top = `${cRect.top - hRect.top + row * m.height}px`;
    ctx.scale(dpr, dpr); // width 대입이 ctx 를 리셋했음 — scale·font 재설정
    ctx.textBaseline = "alphabetic"; // 렌더러와 동일(명시)
    // 커서색 배경(커서 셀을 덮는다 — 조합이 커서 자리 삽입 예정임을 표시) + 배경색 글자.
    // 색·폰트는 렌더러 자신의 필드에서 읽는다(term.options 는 구성 시점 값 — 어긋날 수 있음).
    const cursorColor = r?.theme?.cursor ?? String(term.options.theme?.cursor ?? "#3b82f6");
    const bgColor = r?.theme?.background ?? String(term.options.theme?.background ?? "#fff");
    ctx.fillStyle = cursorColor;
    ctx.fillRect(0, 0, wCss, hCss);
    ctx.fillStyle = bgColor;
    ctx.font = font;
    ctx.fillText(data, 0, m.baseline); // 렌더러 renderCellText 와 동일: x=셀 좌단, y=baseline, maxWidth 없음
    // 조합 중 표기(언더라인) — 배경색으로 그리면 박스가 잘려 보인다(실측: 30행 중 4행이
    // 배경에 녹아 커서보다 작아 보임 — 결함 ②). 커서색 위 반투명 어두운 띠로: 박스는
    // 커서와 동일한 1셀 높이로 읽히고, 띠는 어느 테마·커서색에서도 조합 중임을 표시한다.
    const ul = Math.max(2, Math.floor(hCss * 0.15));
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(0, hCss - ul, wCss, ul);
    overlay.style.display = "block";
    // 진단 스냅샷(M0) — 커서 rect(렌더러 수식)와의 대조용.
    (window as unknown as Record<string, unknown>).__ghosttyPreeditDiag = {
      overlay: { left: overlay.style.left, top: overlay.style.top, wCss, hCss },
      metrics: { ...m },
      cursor: { x: col * m.width, y: row * m.height, w: m.width, h: m.height },
      canvasRect: { left: cRect.left, top: cRect.top, w: cRect.width, h: cRect.height },
      hostRect: { left: hRect.left, top: hRect.top },
      dpr: window.devicePixelRatio,
      font,
      advance,
    };
  };

  let composing = false;
  let lastData = "";
  const onStart = (): void => {
    composing = true;
    lastData = "";
  };
  const onUpdate = (e: Event): void => {
    if (!composing) return;
    const data = (e as CompositionEvent).data ?? "";
    lastData = data;
    if (!data) {
      overlay.style.display = "none";
      return;
    }
    draw(data);
  };
  const onEnd = (): void => {
    composing = false;
    lastData = "";
    overlay.style.display = "none";
  };
  // 조합 미완료 중 포커스 아웃: WebKit 이 조합을 커밋하면 compositionend 가 와서 위 onEnd 로
  // 정리된다. 커밋하지 않는 경로(윈도 전환 등)에서는 compositionend 가 없어 프리뷰가 비포커스
  // 터미널 위에 유령으로 남는다 — 프리뷰만 숨기고 조합 상태는 건드리지 않는다(소유권은 IME).
  // 복귀 후 조합이 살아 있으면 focusin/다음 compositionupdate 가 되살린다.
  const onFocusOut = (): void => {
    overlay.style.display = "none";
    // WebKit 은 조합 중 blur 시 compositionend 를 발화하지 않는다(WebKit #164369) → 조합 텍스트
    // 유실. 포커스가 떠나기 전 마지막 조합 데이터로 compositionend 를 합성 발화해 정상 커밋
    // 경로(ghostty-web handleCompositionEnd → onData → pty)를 태운다. WebKit 이 이미 커밋했으면
    // (실 compositionend 발화 → onEnd 로 composing=false) 이 가드가 false 라 이중 커밋을 막는다.
    if (composing && lastData) {
      target.dispatchEvent(new CompositionEvent("compositionend", { data: lastData, bubbles: true }));
    }
  };
  const onFocusIn = (): void => {
    if (composing && lastData) draw(lastData);
  };
  // 리스너는 이 플러그인 소유 DOM(target=term.element)에만 건다 — 공유 webview(document) 오염 금지(R7).
  target.addEventListener("compositionstart", onStart, true);
  target.addEventListener("compositionupdate", onUpdate, true);
  target.addEventListener("compositionend", onEnd, true);
  target.addEventListener("focusout", onFocusOut, true);
  target.addEventListener("focusin", onFocusIn, true);

  return {
    dispose() {
      target.removeEventListener("compositionstart", onStart, true);
      target.removeEventListener("compositionupdate", onUpdate, true);
      target.removeEventListener("compositionend", onEnd, true);
      target.removeEventListener("focusout", onFocusOut, true);
      target.removeEventListener("focusin", onFocusIn, true);
      overlay.remove();
      for (const [el, prev] of prevStyles) {
        el.style.fontSize = prev.fontSize;
        el.style.color = prev.color;
        el.style.caretColor = prev.caret;
      }
    },
  };
}
