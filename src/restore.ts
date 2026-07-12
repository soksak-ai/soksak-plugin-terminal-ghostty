// 터미널 화면 복원 오케스트레이션 — 이 플러그인이 화면 복원을 소유한다. 세 경로:
//   warm  라이브 미러가 있다 → 사이드카 rehydrate → inert 페인트 → from_seq 로 라이브 이음.
//   cold  죽은 세션 → 봉인 블롭 읽기(사이드카 불요) → inert 페인트 + 소실 고지 → 신선 셸.
//   fresh 복원할 것 없음 → 신선 스폰(프롬프트) + 명령-블록 floor.
// degraded: 사이드카 사망 loud 고지 + 리스폰 → 봉인 폴백. 봉인마저 없으면 degraded-fresh 고지 +
//   신선 셸(코어 폴백 없음). 무음 금지.
import type { PluginApi } from "./host";
import { t } from "./i18n";

// 사이드카 유닛 — plugin.json sidecars[].name 과 정합(cmd = "sidecar:{name}").
export const SIDECAR_NAME = "terminal-alacritty";

// 스폰은 항상 replay 를 명시한다 — undefined("코어 기본")는 없다. "none"=소비자 소유 또는
// 신선(코어 재생 없음), {fromSeq}=warm 핸드오프.
export type ReplayControl = "none" | { fromSeq: number };

export interface RestoreOutcome {
  replay: ReplayControl;
  // 소비자가 복원 화면을 그렸는가 — true 면 명령-블록 floor(이력 repaint)를 겹치지 않는다.
  // painted=false 면 코어 폴백에 기대지 않고, floor 가 이력 바닥을 깐다(복원 사다리 최후 단).
  painted: boolean;
}

// base64(ANSI 바이트) → Uint8Array. term.write 에 그대로 넘겨 raw 를 UTF-8 왜곡 없이 보존.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 생존 서비스 사이드카 스폰(idempotent — 싱글턴 프로브가 중복을 흡수). app.process 없으면 no-op.
// detached=setsid 생존(앱 종료를 넘어 산다). 실패는 삼키지 않고 활동 로그로 고지(무음 금지).
export function ensureSidecar(app: PluginApi): void {
  const proc = app.process;
  if (!proc) return;
  proc.spawn(`sidecar:${SIDECAR_NAME}`, [], { detached: true }).catch((e: unknown) => {
    app.activity.publish("terminal.sidecar.spawn-failed", {
      message: `${t("sidecar.spawn-failed", app.locale())} (${String(e)})`,
    });
  });
}

// 터미널 스폰 직후 호출 — 사이드카가 이 pane 의 세션을 구독하게 한다(부팅 후 태어난 세션의
// tee 를 근접-birth 에 잡아 다음 재시작의 warm 복원을 가능케 한다). 멱등.
//
// 사이드카 스폰(ensureSidecar)은 비동기라 첫 부팅엔 아직 서비스 소켓이 안 떠 있을 수 있다.
// 한 번만 시도하고 삼키면 구독이 안 서고, 이후 출력(사용자 명령)은 미러에 안 담겨 다음
// 재시작 warm 복원이 그 이력을 잃는다. 그래서 구독이 설 때까지 유계 재시도(백오프)한다 —
// 사이드카가 뜨는 즉시(대개 1~2s) 구독해, 사용자가 명령을 치기 전에 tee 를 잡는다. 유계
// 초과는 loud 고지(무음 아님) — 이번 부팅 복원 충실도가 제한됨을 알린다.
export async function ensureSession(
  app: PluginApi,
  paneId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const pty = app.pty;
  if (!pty) return;
  const deadline = Date.now() + 8000;
  let delay = 150;
  while (Date.now() < deadline) {
    try {
      const r = await pty.sidecarRequest({ op: "ensureSession", pane: paneId, cols, rows });
      if (r.ok === true) return; // 구독됨(또는 이미 미러 중).
      // ok:false(NOT_FOUND 등) — 세션이 아직 데몬 목록에 안 떴거나 사이드카 준비 중. 재시도.
    } catch {
      // 사이드카 미준비(relay connect 실패) — 재시도.
    }
    await new Promise((res) => setTimeout(res, delay));
    delay = Math.min(delay * 2, 1000);
  }
  app.activity.publish("terminal.sidecar.subscribe-timeout", {
    message: `${t("sidecar.subscribe-timeout", app.locale())} (${paneId})`,
  });
}

// 마운트 시 화면 복원 결정 + inert 페인트(PTY 우회). spawn 전에 부른다: warm 은 uptoSeq 좌표가
// 필요하고, cold 는 신선 셸 출력이 겹치기 전에 먼저 그려야 한다.
export async function orchestrateRestore(
  app: PluginApi,
  paneId: string,
  writeInert: (data: string | Uint8Array) => void,
): Promise<RestoreOutcome> {
  const pty = app.pty;
  if (!pty) return { replay: "none", painted: false };

  // 1) warm — 라이브 미러에서 rehydrate(사이드카 서비스 소켓 릴레이).
  //
  // 사이드카 스폰(ensureSidecar)은 비동기라 부팅 직후엔 서비스 소켓이 아직 없어 connect 가
  // 거부되고 rehydrate 가 throw 한다. 즉시 degraded 로 떨어지면 '이력 있는 복원 터미널이 사이드카
  // 기동을 앞지르는' 부팅-레이스에서 warm 복원을 잃는다(부팅 순서라는 우연이 복원 유실을 만들면
  // 안 된다). 그래서 사이드카가 뜰 때까지 유계 백오프 재시도한다 — 부팅 핸드셰이크(총 수 초 상한),
  // 메인라인 폴링 아님(종료 조건 = 사이드카 응답 or 데드라인 소진). ensureSession(재시도)과 같은
  // 패턴. 사이드카가 '응답'하면 즉시 반환한다: ok:true=warm, ok:false(NOT_FOUND)=미러 없음→cold/fresh
  // (둘 다 재시도 아님 — 사이드카가 답했다). 소진 후에만 degraded 를 선언한다.
  const deadline = Date.now() + 4000;
  let delay = 100;
  for (;;) {
    try {
      const reply = await pty.sidecarRequest({ op: "rehydrate", pane: paneId });
      if (reply.ok === true) {
        const data = reply.data as { paint: string; uptoSeq: number; altActive: boolean };
        writeInert(b64ToBytes(data.paint));
        // 소비자가 uptoSeq 까지 그렸다 → 코어는 그 seq 부터 raw 링을 이어 붙인다(레이스-프리).
        return { replay: { fromSeq: data.uptoSeq }, painted: true };
      }
      // ok:false(NOT_FOUND 등) — 사이드카가 떴고 이 pane 미러 없음 → cold/fresh(재시도 아님).
      return coldOrFresh(app, paneId, writeInert, false);
    } catch {
      // 사이드카 소켓 미도달(스폰 중) — 데드라인까지 유계 재시도.
      if (Date.now() >= deadline) break;
      await new Promise((res) => setTimeout(res, delay));
      delay = Math.min(delay * 2, 1000);
    }
  }

  // 2) 재시도 소진 — 사이드카가 끝내 안 떴다. degraded loud 고지 + 리스폰, 봉인 폴백(사이드카 불요).
  app.activity.publish("terminal.restore.degraded", { message: t("restore.degraded", app.locale()) });
  ensureSidecar(app);
  return coldOrFresh(app, paneId, writeInert, true);
}

async function coldOrFresh(
  app: PluginApi,
  paneId: string,
  writeInert: (data: string | Uint8Array) => void,
  sidecarDown: boolean,
): Promise<RestoreOutcome> {
  const pty = app.pty;
  if (!pty) return { replay: "none", painted: false };
  try {
    const sealed = await pty.readSealedScreen(paneId);
    if (sealed) {
      writeInert(b64ToBytes(sealed.paintB64));
      // 소실 고지 — 실행 중이던 프로세스는 종료되어 복원되지 않았음을 화면에 찍는다(무음 금지).
      writeInert(`\x1b[2m${t("cold-restore-notice", app.locale())}\x1b[0m\r\n`);
      return { replay: "none", painted: true };
    }
  } catch (e) {
    // 잠금(fail-closed) 등으로 cold 차단 — floor 로 떨어진다(라이브만 시작).
    app.activity.publish("terminal.restore.cold-blocked", {
      message: `${t("restore.cold-blocked", app.locale())} (${String(e)})`,
    });
  }
  // 봉인 블롭 없음(또는 cold 차단):
  if (sidecarDown) {
    // 사이드카 다운 + 봉인 기록 없음 — 복원할 화면이 없다. 코어 폴백은 없다: 무음 대신
    // degraded 를 화면·활동에 loud 고지하고 신선 셸로 간다. 명령-블록
    // floor 가 이력 바닥을 깐다(복원 사다리 최후 단).
    writeInert(`\x1b[2m${t("restore.degraded-fresh", app.locale())}\x1b[0m\r\n`);
    app.activity.publish("terminal.restore.degraded-fresh", {
      message: t("restore.degraded-fresh", app.locale()),
    });
    return { replay: "none", painted: false };
  }
  // 신선 터미널 — 복원할 것 없음(신선 스폰이 프롬프트를 보이고 floor 가 이력을 그린다).
  return { replay: "none", painted: false };
}
