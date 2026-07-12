// 코어 플러그인 API 중 이 플러그인이 쓰는 표면만 선언.
// soksak-plugin-spec v1 의 SoksakPluginApi 와 동형 — 별도 repo, 코어 소스 비의존.
// 미선언 권한 표면은 런타임에 undefined.

export interface Disposable {
  dispose(): void;
}

// 코어 viewRegistry.PluginViewContext 와 동형.
export interface PluginViewContext {
  projectId: string;
  root: string | null;
  paneId: string | null;
  viewId: string | null;
  // 마운트 시 1회 자동 실행할 명령(에이전트 프로그램 — 터미널이 PTY 로 실행). 없으면 null.
  command: string | null;
  /** 복원 seam(B3) — 재시작 복원 마운트면 관찰됐던 런타임(cwd·state). 새 뷰는 null. */
  restore?: { cwd: string | null; state?: unknown } | null;
  setBadge: (badge: number | "dot" | null) => void;
  setStatus: (status: { code: string; message?: string } | null) => void;
  setTitle: (title: string) => void;
}

export interface PluginViewProvider {
  mount(container: HTMLElement, ctx: PluginViewContext): void;
  unmount?(container: HTMLElement): void;
  prepareFocusTransfer?(container: HTMLElement, ctx: PluginViewContext): void;
  focus?(
    container: HTMLElement,
    ctx: PluginViewContext,
    request: { signal: AbortSignal },
  ): void;
}

export interface ParamSpec {
  type: string;
  description?: string;
  required?: boolean;
}

export interface PluginCommandSpec {
  description: string;
  triggers?: Record<string, string>;
  params?: Record<string, ParamSpec>;
  returns?: string;
  message?: (data: Record<string, unknown>) => string;
  handler: (params: Record<string, unknown>) => Promise<object> | object;
}

export interface CommandOutcome {
  ok: boolean;
  [k: string]: unknown;
}

// app.pty — 코어 PTY 구동 표면 (pty 권한 필요).
export interface PtyApi {
  spawn(opts: {
    cols: number;
    rows: number;
    cwd?: string;
    shell?: string;
    paneId?: string;
    /** 화면 복원 제어(배관) — 항상 명시: "none"=소비자 소유, {fromSeq}=warm 핸드오프. */
    replay?: "none" | { fromSeq: number };
  }): Promise<number>;
  write(id: number, data: string | Uint8Array): Promise<void>;
  resize(id: number, cols: number, rows: number): Promise<void>;
  ack(id: number, bytes: number): Promise<void>;
  close(id: number): Promise<void>;
  onData(id: number, cb: (data: Uint8Array) => void): Disposable;
  which(bin: string): Promise<string | null>;
  registerIo(
    paneId: string,
    io: { readBuffer: (lines?: number) => string; sendInput: (data: string) => void },
  ): Disposable;
  /** 생존 서비스 사이드카 서비스 소켓에 NDJSON 요청/응답 1왕복 릴레이. 코어 내용 불가지 + 현재
   *  창 label 스탬프. 연결 실패는 throw(사이드카 사망 loud). */
  sidecarRequest(req: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 이 pane 의 봉인 체크포인트를 앱 볼트로 개봉한 평문(base64)+altActive. 잠금=throw, 없음=null. */
  readSealedScreen(
    paneId: string,
  ): Promise<{ paintB64: string; altActive: boolean } | null>;
  /** 이 pane 에 라이브 데몬 세션이 있는가 — warm 복원 후보 판정(사이드카 무관·즉답, 데몬 안 띄움).
   *  false = 신선/cold/데몬 미가동 → 사이드카 rehydrate(재시도)를 안 태우고 즉시 진행. */
  paneAlive(paneId: string): Promise<boolean>;
}

// app.process — 외부 서브프로세스 spawn("process" 권한). 생존 서비스 사이드카를 detached 스폰.
export interface ProcessApi {
  /** 매니페스트 sidecars[] 에서 이 계약을 구현한다고 선언한 유닛 이름 — 유닛 선택의 단일진실.
   *  번들에 유닛명을 상수로 굳히지 않기 위한 면이다(매니페스트만 바꿔도 유닛이 바뀐다). */
  sidecarName: (interfaceId: string) => string;
  spawn(
    cmd: string,
    args: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string>;
      envRemove?: string[];
      secretEnv?: Record<string, string>;
      detached?: boolean;
    },
  ): Promise<number>;
  onExit(handle: number, cb: (code: number) => void): Disposable;
  kill(handle: number): Promise<void>;
}

export interface PluginApi {
  pluginId: string;
  locale: () => string;
  commands?: {
    register: (name: string, spec: PluginCommandSpec) => Disposable;
    execute: (name: string, params?: Record<string, unknown>) => Promise<CommandOutcome>;
  };
  events: {
    on: (event: string, fn: (payload: unknown) => void) => Disposable;
  };
  activity: {
    publish: (
      kind: string,
      entry: { message: string; speak?: string } & Record<string, unknown>,
    ) => void;
  };
  data?: {
    define: (collection: string, opts: { indexes?: string[]; fts?: string[] }) => Promise<void>;
    put: (
      collection: string,
      doc: Record<string, unknown>,
      opts?: { scope?: string; id?: string },
    ) => Promise<string>;
    query: (
      collection: string,
      opts?: {
        scope?: string;
        where?: Record<string, unknown>;
        order?: string;
        desc?: boolean;
        limit?: number;
      },
    ) => Promise<unknown[]>;
    retentionTrim: (collection: string, scope: string, cap: number) => Promise<number>;
  };
  ui?: {
    registerView: (viewId: string, provider: PluginViewProvider) => Disposable;
  };
  pty?: PtyApi;
  // 생존 서비스 사이드카 스폰용("process" 권한). 미선언이면 undefined(graceful).
  process?: ProcessApi;
  settings: {
    get: (key: string) => unknown;
    all: () => Record<string, unknown>;
    onChange: (cb: (all: Record<string, unknown>) => void) => Disposable;
  };
}

export interface PluginContext {
  app: PluginApi;
  subscriptions: { push(d: Disposable): void };
}
