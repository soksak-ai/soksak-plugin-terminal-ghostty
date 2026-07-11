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
