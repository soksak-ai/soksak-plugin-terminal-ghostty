// terminal-ghostty i18n — 복원 오케스트레이션이 화면·활동 로그에 찍는 사람 표면 텍스트.
type Dict = Record<string, string>;

const EN: Dict = {
  "cold-restore-notice":
    "[Restored from a sealed checkpoint — the running process ended and was not restored; only the screen record was repainted]",
  "restore.degraded":
    "Could not reach the terminal restore sidecar — restore is degraded (falling back to the sealed record).",
  "restore.cold-blocked": "Sealed screen restore is blocked; starting live only.",
  "sidecar.spawn-failed": "Failed to spawn the terminal restore sidecar.",
  "sidecar.subscribe-timeout":
    "The restore sidecar did not subscribe this session in time — restore fidelity is limited for this session.",
};

const KO: Dict = {
  "cold-restore-notice":
    "[봉인 체크포인트에서 복원 — 실행 중이던 프로세스는 종료되어 복원되지 않았고, 화면 기록만 다시 그렸습니다]",
  "restore.degraded":
    "터미널 복원 사이드카에 닿지 못해 복원이 제한됩니다(봉인 기록으로 폴백).",
  "restore.cold-blocked": "봉인 화면 복원이 차단되어 라이브만 시작합니다.",
  "sidecar.spawn-failed": "터미널 복원 사이드카 스폰에 실패했습니다.",
  "sidecar.subscribe-timeout":
    "복원 사이드카가 이 세션을 제때 구독하지 못했습니다 — 이 세션의 복원 충실도가 제한됩니다.",
};

export function t(key: string, lang: string): string {
  const dict = lang === "ko" ? KO : EN;
  return dict[key] ?? EN[key] ?? key;
}
