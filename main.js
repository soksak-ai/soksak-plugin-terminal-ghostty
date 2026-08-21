// ../../../soksak-kits/soksak-kit-plugin-terminal/src/terminal-status-publication.ts
function createTerminalStatusController(options) {
  let status = {
    phase: "initializing",
    pluginId: options.pluginId,
    engineId: options.engineId,
    rendererId: options.rendererId,
    rendererProfile: options.rendererProfile,
    recoveryOutcome: "fresh",
    fidelity: "unavailable",
    failure: null
  };
  const listeners = /* @__PURE__ */ new Set();
  const publish = () => {
    options.root.dataset.terminalPhase = status.phase;
    options.root.dataset.terminalRecovery = status.recoveryOutcome;
    options.root.dataset.terminalFidelity = status.fidelity;
    if (status.failure) options.root.dataset.terminalFailure = status.failure.code;
    else delete options.root.dataset.terminalFailure;
    const copy = { ...status, failure: status.failure ? { ...status.failure } : null };
    options.root.dispatchEvent(new CustomEvent("soksak:terminal-status", {
      bubbles: true,
      detail: copy
    }));
    options.publish(copy);
    for (const listener of listeners) listener(copy);
    return copy;
  };
  publish();
  return {
    set(phase, next = {}) {
      status = {
        ...status,
        phase,
        ...next.recoveryOutcome ? { recoveryOutcome: next.recoveryOutcome } : {},
        ...next.fidelity ? { fidelity: next.fidelity } : {},
        ...next.failure !== void 0 ? { failure: next.failure } : {}
      };
      return publish();
    },
    current: () => ({ ...status, failure: status.failure ? { ...status.failure } : null }),
    wait(phases, timeoutMs) {
      const accepted = new Set(phases);
      if (accepted.has(status.phase)) return Promise.resolve(this.current());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          listeners.delete(onStatus);
          reject(new Error(`terminal phase wait timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onStatus = (next) => {
          if (!accepted.has(next.phase)) return;
          clearTimeout(timer);
          listeners.delete(onStatus);
          resolve(next);
        };
        listeners.add(onStatus);
      });
    },
    close: () => {
      status = { ...status, phase: "closed" };
      return publish();
    }
  };
}

// ../../../soksak-kits/soksak-kit-plugin-terminal/src/terminal-condition-wait.ts
async function waitForTerminalConditions(options) {
  const deadline = performance.now() + options.timeoutMs;
  const remaining = () => Math.max(1, Math.ceil(deadline - performance.now()));
  const text = options.contains ? await options.waitForText(options.contains, remaining()) : void 0;
  const status = await options.status.wait([options.phase, "blocked"], remaining());
  return text === void 0 ? status : { ...status, text };
}

// ../../../soksak-kits/soksak-kit-plugin-terminal/src/terminal-session-binding.ts
var KEY_ENV = "SOKSAK_TERMINAL_CHECKPOINT_KEY";
function createTerminalSessionBinding(host, options) {
  let sequence = 0;
  const request = (command, value) => ({
    id: `terminal-${++sequence}`,
    command,
    args: { request: value }
  });
  const answer = (response) => {
    if (response.ok !== true) throw new Error(typeof response.error === "string" ? response.error : "unit refused");
    return response.result?.data ?? {};
  };
  let ptyPromise = null;
  const pty = () => ptyPromise ??= host.sidecar.open(options.ptyUnit);
  let providerPromise = null;
  const provider = () => providerPromise ??= (async () => {
    const key = options.checkpointKey ?? "terminal-checkpoint-key-v1";
    options.onOperation?.("opening-provider");
    return host.sidecar.open(options.providerUnit, {
      generatedSecretEnv: { [KEY_ENV]: { key, bytes: 32 } }
    });
  })();
  const streams = /* @__PURE__ */ new Map();
  const readers = /* @__PURE__ */ new Map();
  const pending = /* @__PURE__ */ new Map();
  const taken = /* @__PURE__ */ new Map();
  const encode = (text) => {
    let binary = "";
    for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  let loginShellPromise = null;
  const loginShell = () => loginShellPromise ??= (async () => {
    const executed = await host.commands?.execute?.("app.environment", {});
    const data = executed && typeof executed === "object" && "data" in executed ? executed.data : executed;
    const shell = data && typeof data === "object" ? data.loginShell : void 0;
    if (typeof shell !== "string" || shell === "") {
      throw new Error("app.environment returned no login shell");
    }
    return shell;
  })();
  return {
    async open(paneId, cols, rows, replay, observerToken) {
      const channel = await pty();
      const shell = await loginShell();
      const opened = answer(await channel.send(request("pty.open", {
        paneId,
        cols,
        rows,
        shell,
        windowLabel: host.windowLabel(),
        ...observerToken ? { observerToken } : {}
      })));
      const session = Number(opened.session);
      const leaseToken = replay === "none" ? void 0 : replay.leaseToken;
      const stream = await channel.stream(request(
        leaseToken ? "pty.attachLease" : "pty.attach",
        leaseToken ? { token: leaseToken } : { session }
      ), { onBytes(bytes) {
        const throughSeq = (taken.get(session) ?? 0) + bytes.length;
        taken.set(session, throughSeq);
        void channel.send(request("pty.ack", { session, throughSeq })).catch(() => {
        });
        const subscribed = readers.get(session);
        if (subscribed?.size) subscribed.forEach((reader) => reader(bytes, throughSeq));
        else pending.set(session, [...pending.get(session) ?? [], { bytes, throughSeq }]);
        host.terminal?.observe?.(paneId, bytes);
      } });
      const attached = answer(stream.answer);
      const startSeq = Number(attached.startSeq);
      if (!Number.isSafeInteger(startSeq) || startSeq < 0) {
        stream.close.dispose();
        throw new Error("pty.attach returned invalid startSeq");
      }
      taken.set(session, startSeq);
      streams.set(session, stream.close);
      return session;
    },
    async write(session, data) {
      answer(await (await pty()).send(request("pty.write", { session, dataB64: encode(data) })));
    },
    async resize(session, cols, rows) {
      answer(await (await pty()).send(request("pty.resize", { session, cols, rows })));
    },
    async close(session) {
      release(session);
      answer(await (await pty()).send(request("pty.close", { session })));
    },
    detach(session) {
      release(session);
    },
    onData(session, callback) {
      const set = readers.get(session) ?? /* @__PURE__ */ new Set();
      readers.set(session, set);
      set.add(callback);
      for (const item of pending.get(session) ?? []) callback(item.bytes, item.throughSeq);
      pending.delete(session);
      return { dispose: () => void readers.get(session)?.delete(callback) };
    },
    async paneAlive(paneId) {
      return answer(await (await pty()).send(request("pty.pane", { paneId }))).held === true;
    },
    async providerRequest(value) {
      const operation = typeof value.op === "string" ? value.op : "";
      const commands = {
        prepareSession: "terminal.prepareSession",
        ensureSession: "terminal.ensureSession",
        rehydrate: "terminal.rehydrate",
        resize: "terminal.resize",
        status: "terminal.status",
        archived: "terminal.archived",
        retire: "terminal.retire",
        archive: "terminal.archive",
        frame: "terminal.frame"
      };
      const command = commands[operation];
      if (!command) throw new Error(`unknown terminal recovery operation ${operation}`);
      const { op: _op, ...payload } = value;
      const response = await (await provider()).send(request(command, { ...payload, window: host.windowLabel() }));
      if (response.ok !== true) return { ok: false, code: response.result?.code ?? "FAILED", message: response.error ?? "recovery request failed" };
      return { ok: true, code: "OK", data: answer(response) };
    },
    async diagnostics() {
      const [ptyStatus, providerStatus] = await Promise.all([
        (async () => answer(await (await pty()).send(request("pty.status", {}))))(),
        (async () => {
          const response = await this.providerRequest({ op: "status" });
          return response.ok === true && response.data && typeof response.data === "object" ? response.data : response;
        })()
      ]);
      return { pty: ptyStatus, provider: providerStatus };
    },
    async closeWindow(windowLabel) {
      answer(await (await pty()).send(request("pty.closeWindow", { windowLabel })));
    }
  };
  function release(session) {
    streams.get(session)?.dispose();
    streams.delete(session);
    readers.delete(session);
    pending.delete(session);
    taken.delete(session);
  }
}

// ../../../soksak-kits/soksak-kit-plugin-terminal/src/provider-frame-presenter.ts
function createProviderFramePresenter(container, send) {
  container.dataset.node = "terminal-root";
  const screen = document.createElement("pre");
  screen.dataset.node = "terminal-screen";
  screen.setAttribute("role", "log");
  screen.setAttribute("aria-live", "polite");
  screen.tabIndex = -1;
  Object.assign(screen.style, { margin: "0", width: "100%", height: "100%", overflow: "auto", whiteSpace: "pre" });
  const input2 = document.createElement("textarea");
  input2.dataset.node = "terminal-input";
  input2.setAttribute("aria-label", "Terminal input");
  input2.autocapitalize = "off";
  input2.autocomplete = "off";
  input2.spellcheck = false;
  Object.assign(input2.style, { position: "absolute", width: "1px", height: "1px", opacity: "0" });
  input2.addEventListener("input", () => {
    if (input2.value) send(input2.value);
    input2.value = "";
  });
  input2.addEventListener("keydown", (event) => {
    const sequences = { Enter: "\r", Backspace: "\x7F", Tab: "	", ArrowUp: "\x1B[A", ArrowDown: "\x1B[B", ArrowRight: "\x1B[C", ArrowLeft: "\x1B[D" };
    const sequence = sequences[event.key];
    if (sequence) {
      event.preventDefault();
      send(sequence);
    }
  });
  const recovery = document.createElement("span");
  recovery.dataset.node = "terminal-restore-status";
  recovery.hidden = true;
  container.replaceChildren(screen, input2, recovery);
  let text = "";
  let size = { cols: 0, rows: 0 };
  const textListeners = /* @__PURE__ */ new Set();
  return {
    root: container,
    screen,
    input: input2,
    render(frame) {
      size = { cols: frame.cols, rows: frame.rows };
      text = frame.lines.map((line) => line.map((cell) => cell.text).join("").replace(/ +$/, "")).join("\n");
      screen.replaceChildren();
      frame.lines.forEach((line, row) => {
        let column = 0;
        for (const cell of line) {
          const span = document.createElement("span");
          span.textContent = cell.text;
          span.dataset.fg = cell.fg;
          span.dataset.bg = cell.bg;
          span.dataset.attrs = String(cell.attrs);
          if (cell.fg.startsWith("#")) span.style.color = cell.fg;
          if (cell.bg.startsWith("#")) span.style.backgroundColor = cell.bg;
          if (cell.attrs & 1) span.style.fontWeight = "700";
          if (cell.attrs & 4) span.style.fontStyle = "italic";
          if (cell.attrs & 8) span.style.textDecoration = "underline";
          if (row === frame.cursor[0] && column === frame.cursor[1]) {
            span.dataset.cursor = "true";
            span.style.outline = "1px solid currentColor";
          }
          screen.append(span);
          column += cell.wide ? 2 : 1;
        }
        if (row + 1 < frame.lines.length) screen.append(document.createTextNode("\n"));
      });
      screen.dataset.cursorRow = String(frame.cursor[0]);
      screen.dataset.cursorColumn = String(frame.cursor[1]);
      screen.dataset.altActive = String(frame.alt_active);
      for (const listener of textListeners) listener(text);
    },
    read(lines) {
      return lines && lines > 0 ? text.split("\n").slice(-lines).join("\n") : text;
    },
    size: () => ({ ...size }),
    waitForText(contains, timeoutMs) {
      if (text.includes(contains)) return Promise.resolve(text);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          textListeners.delete(onText);
          reject(new Error(`terminal text wait timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onText = (next) => {
          if (!next.includes(contains)) return;
          clearTimeout(timer);
          textListeners.delete(onText);
          resolve(next);
        };
        textListeners.add(onText);
      });
    },
    focus() {
      input2.focus({ preventScroll: true });
      return document.activeElement === input2;
    },
    dispose() {
      container.replaceChildren();
    }
  };
}

// ../../../soksak-kits/soksak-kit-plugin-terminal/node_modules/.pnpm/@soksak+soksak-contract-plugin-terminal@file+..+..+soksak-contracts+soksak-contract-plugin-terminal/node_modules/@soksak/soksak-contract-plugin-terminal/src/index.ts
var TERMINAL_PLUGIN_CONTRACT = Object.freeze({
  id: "soksak-spec-plugin-terminal",
  version: "0.0.1"
});
var TERMINAL_PLUGIN_PHASES = Object.freeze([
  "initializing",
  "preparing-recovery",
  "applying-snapshot",
  "attaching-live-stream",
  "live",
  "archived",
  "degraded-tail",
  "blocked",
  "closed"
]);
var TERMINAL_PLUGIN_COMMANDS = Object.freeze([
  "status",
  "wait",
  "archive",
  "send",
  "read",
  "clear",
  "focus",
  "recovery-status"
]);
var input = (properties, required = []) => Object.freeze({ properties: Object.freeze(properties), required: Object.freeze(required), additionalProperties: false });
var output = (properties, required) => input(properties, required);
var statusOutput = output({
  phase: "string",
  pluginId: "string",
  engineId: "string",
  rendererId: "string",
  rendererProfile: "string",
  recoveryOutcome: "string",
  fidelity: "string",
  failure: ["object", "null"]
}, ["phase", "pluginId", "engineId", "rendererId", "rendererProfile", "recoveryOutcome", "fidelity", "failure"]);
var viewInput = () => input({ view: "string" });
var TERMINAL_PLUGIN_COMMAND_SCHEMAS = Object.freeze({
  status: { danger: "none", input: viewInput(), output: statusOutput },
  wait: {
    danger: "none",
    input: input({ view: "string", phase: "string", timeoutMs: "number", contains: "string" }, ["phase"]),
    output: output({
      phase: "string",
      recoveryOutcome: "string",
      fidelity: "string",
      failure: ["object", "null"],
      cols: "number",
      rows: "number",
      operation: "string"
    }, ["phase", "recoveryOutcome", "fidelity"])
  },
  archive: {
    danger: "none",
    input: viewInput(),
    output: output({ archived: "boolean", bytes: "number" }, ["archived"])
  },
  send: {
    danger: "inject",
    input: input({ view: "string", data: "string" }, ["data"]),
    output: output({ sent: ["number", "boolean"] }, ["sent"])
  },
  read: {
    danger: "none",
    input: input({ view: "string", lines: "number" }),
    output: output({ text: "string" }, ["text"])
  },
  clear: {
    danger: "none",
    input: viewInput(),
    output: output({ cleared: "boolean" }, ["cleared"])
  },
  focus: {
    danger: "none",
    input: viewInput(),
    output: output({ focused: "boolean" }, ["focused"])
  },
  "recovery-status": { danger: "none", input: viewInput(), output: statusOutput }
});
var TERMINAL_PLUGIN_NODES = Object.freeze([
  "terminal-root",
  "terminal-screen",
  "terminal-input",
  "terminal-restore-status"
]);

// ../../../soksak-kits/soksak-kit-plugin-terminal/src/provider-terminal-plugin.ts
var viewParam = { type: "string", description: { en: "Terminal view id", ko: "\uD130\uBBF8\uB110 \uBDF0 ID" } };
function activateProviderTerminalPlugin(host, subscriptions, config) {
  const screens = /* @__PURE__ */ new Map();
  const binding = createTerminalSessionBinding(host, {
    ptyUnit: "pty",
    providerUnit: config.providerUnit,
    onOperation(operation) {
      for (const screen of screens.values()) {
        screen.presenter.root.dataset.terminalOperation = operation;
      }
    }
  });
  const register = (name, params, handler) => {
    const description = {
      en: `${config.engineId} terminal ${name}`,
      ko: `${config.engineId} \uD130\uBBF8\uB110 ${name}`
    };
    const schema = TERMINAL_PLUGIN_COMMAND_SCHEMAS[name];
    const disposable = host.commands.register(name, {
      description,
      params,
      returns: "{}",
      message: () => description,
      handler,
      ...schema?.danger === "inject" ? { danger: "inject" } : {}
    });
    if (disposable) subscriptions.push(disposable);
  };
  const target = (params) => {
    if (typeof params.view === "string") return screens.get(params.view);
    if (screens.size === 1) return screens.values().next().value;
    return void 0;
  };
  const view = {
    mount(container, context) {
      const pane = context.viewId ?? "";
      if (!pane) throw new Error("terminal view requires a view id");
      let session = 0;
      let stopped = false;
      let output2;
      let io;
      let requestedSequence = 0;
      let renderedSequence = 0;
      let rendering = false;
      let writable = false;
      const terminalSize = () => ({
        cols: Math.max(1, Math.floor(container.clientWidth / 8)),
        rows: Math.max(1, Math.floor(container.clientHeight / 16))
      });
      const presenter = createProviderFramePresenter(container, (text) => {
        if (writable && session) void binding.write(session, text);
      });
      const status = createTerminalStatusController({
        root: container,
        pluginId: config.pluginId,
        engineId: config.engineId,
        rendererId: `${config.engineId}-frame`,
        rendererProfile: "web",
        publish(value) {
          context.setStatus?.(value.failure ? {
            code: value.failure.code,
            message: value.failure.message
          } : null);
        }
      });
      const applyFrame = (value) => {
        if (!value || typeof value !== "object") return false;
        presenter.render(value);
        return true;
      };
      const requireReply = (reply, operation) => {
        if (reply.ok !== true) {
          const code = typeof reply.code === "string" ? reply.code : "FAILED";
          const message = typeof reply.message === "string" ? reply.message : "request failed";
          throw new Error(`${operation} failed (${code}): ${message}`);
        }
        return reply.data && typeof reply.data === "object" ? reply.data : {};
      };
      const renderLatest = async () => {
        if (rendering || stopped || requestedSequence <= renderedSequence) return;
        rendering = true;
        try {
          while (!stopped && requestedSequence > renderedSequence) {
            const sequence = requestedSequence;
            const response = await binding.providerRequest({
              op: "frame",
              pane,
              afterSequence: sequence
            });
            applyFrame(requireReply(response, "frame"));
            renderedSequence = sequence;
          }
        } finally {
          rendering = false;
        }
      };
      const resizeSession = () => {
        if (!session || container.clientWidth <= 0 || container.clientHeight <= 0) return;
        const { cols, rows } = terminalSize();
        void binding.resize(session, cols, rows);
        void binding.providerRequest({ op: "resize", pane, cols, rows });
      };
      const attach = (opened) => {
        session = opened;
        output2 = binding.onData(session, (_bytes, throughSeq) => {
          requestedSequence = Math.max(requestedSequence, throughSeq);
          void renderLatest();
        });
        writable = true;
        io = host.terminal?.registerIo?.(pane, {
          readBuffer: (lines) => presenter.read(lines),
          sendInput: (data) => {
            if (writable && session) void binding.write(session, data);
          }
        });
        resizeSession();
      };
      const startFresh = async () => {
        container.dataset.terminalOperation = "preparing-observer";
        const prepared = requireReply(await binding.providerRequest({
          op: "prepareSession",
          pane,
          cols: 80,
          rows: 24
        }), "prepareSession");
        const token = typeof prepared.observerToken === "string" ? prepared.observerToken : "";
        if (!token) throw new Error("prepareSession returned no observer token");
        container.dataset.terminalOperation = "opening-pty";
        const opened = await binding.open(pane, 80, 24, "none", token);
        container.dataset.terminalOperation = "subscribing-provider";
        requireReply(await binding.providerRequest({
          op: "ensureSession",
          pane,
          cols: 80,
          rows: 24,
          observerToken: token
        }), "ensureSession");
        attach(opened);
        container.dataset.terminalOperation = "ready";
        status.set("live", { recoveryOutcome: "fresh", fidelity: "complete" });
      };
      const startWarm = async () => {
        container.dataset.terminalOperation = "subscribing-provider";
        requireReply(await binding.providerRequest({
          op: "ensureSession",
          pane,
          cols: 80,
          rows: 24
        }), "ensureSession");
        const restored = requireReply(await binding.providerRequest({
          op: "rehydrate",
          pane
        }), "rehydrate");
        const leaseToken = typeof restored.leaseToken === "string" ? restored.leaseToken : "";
        if (!leaseToken || !applyFrame(restored.frame)) {
          throw new Error("rehydrate returned no frame or snapshot lease");
        }
        status.set("applying-snapshot", {
          recoveryOutcome: "continued",
          fidelity: "complete"
        });
        container.dataset.terminalOperation = "attaching-snapshot-lease";
        const opened = await binding.open(pane, 80, 24, { leaseToken });
        attach(opened);
        container.dataset.terminalOperation = "ready";
        status.set("live", { recoveryOutcome: "continued", fidelity: "complete" });
      };
      const startArchived = async () => {
        container.dataset.terminalOperation = "checking-archive";
        const archived = await binding.providerRequest({ op: "archived", pane });
        if (archived.ok !== true) {
          if (archived.code === "NOT_FOUND") return false;
          requireReply(archived, "archived");
        }
        const data = requireReply(archived, "archived");
        if (!applyFrame(data.frame)) throw new Error("archived returned no frame");
        writable = false;
        container.dataset.terminalOperation = "ready";
        status.set("archived", {
          recoveryOutcome: "archived",
          fidelity: "complete"
        });
        return true;
      };
      const start = async () => {
        status.set("preparing-recovery");
        container.dataset.terminalOperation = "checking-live";
        if (await binding.paneAlive(pane)) await startWarm();
        else if (!await startArchived()) await startFresh();
      };
      const resize = new ResizeObserver(resizeSession);
      resize.observe(container);
      void start().catch((error) => status.set("blocked", {
        failure: { code: "START_FAILED", message: String(error) },
        fidelity: "unavailable",
        recoveryOutcome: "blocked"
      }));
      const entry = {
        presenter,
        get session() {
          return session;
        },
        status,
        stop() {
          stopped = true;
          writable = false;
          resize.disconnect();
          output2?.dispose();
          io?.dispose();
          if (session) binding.detach(session);
          status.close();
          presenter.dispose();
        }
      };
      screens.set(pane, entry);
    },
    unmount(container) {
      const found = [...screens.entries()].find(([, value]) => value.presenter.root === container);
      if (!found) return;
      found[1].stop();
      screens.delete(found[0]);
    },
    focus(container, _context, request) {
      if (request.signal.aborted) return;
      const found = [...screens.values()].find((screen) => screen.presenter.root === container);
      found?.presenter.focus();
    }
  };
  subscriptions.push(host.ui.registerView("content", view));
  const publicStatus = (screen) => screen ? {
    ...screen.status.current(),
    ...screen.presenter.size(),
    operation: screen.presenter.root.dataset.terminalOperation ?? "unknown"
  } : {
    pluginId: config.pluginId,
    engineId: config.engineId,
    rendererId: `${config.engineId}-frame`,
    rendererProfile: "web",
    phase: "closed",
    recoveryOutcome: "blocked",
    fidelity: "unavailable",
    failure: null
  };
  register("status", { view: viewParam }, async (params) => ({
    ...publicStatus(target(params)),
    source: await binding.diagnostics()
  }));
  register("archive", { view: viewParam }, async (params) => {
    const screen = target(params);
    if (!screen) return { archived: false };
    const response = await binding.providerRequest({ op: "archive", pane: String(params.view) });
    return response.ok === true ? { archived: true, ...response.data } : response;
  });
  register("wait", {
    phase: {
      type: "string",
      required: true,
      enum: ["initializing", "preparing-recovery", "applying-snapshot", "attaching-live-stream", "live", "archived", "degraded-tail", "blocked", "closed"],
      description: { en: "Terminal phase", ko: "\uD130\uBBF8\uB110 \uB2E8\uACC4" }
    },
    timeoutMs: { type: "number", default: 1e4, description: { en: "Timeout in milliseconds", ko: "\uC81C\uD55C \uC2DC\uAC04(\uBC00\uB9AC\uCD08)" } },
    contains: { type: "string", description: { en: "Screen text", ko: "\uD654\uBA74 \uD14D\uC2A4\uD2B8" } },
    view: viewParam
  }, async (params) => {
    const screen = target(params);
    if (!screen) return publicStatus(void 0);
    const phase = String(params.phase);
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 1e4;
    const waited = await waitForTerminalConditions({
      status: screen.status,
      phase,
      contains: typeof params.contains === "string" && params.contains !== "" ? params.contains : void 0,
      timeoutMs,
      waitForText: screen.presenter.waitForText
    });
    return {
      ...waited,
      ...screen.presenter.size(),
      operation: screen.presenter.root.dataset.terminalOperation ?? "unknown"
    };
  });
  register("read", {
    lines: { type: "number", description: { en: "Trailing line count", ko: "\uB9C8\uC9C0\uB9C9 \uC904 \uC218" } },
    view: viewParam
  }, (params) => ({
    text: target(params)?.presenter.read(
      typeof params.lines === "number" ? params.lines : void 0
    ) ?? ""
  }));
  register("send", {
    data: { type: "string", required: true, description: { en: "Input data", ko: "\uC785\uB825 \uB370\uC774\uD130" } },
    view: viewParam
  }, (params) => {
    const screen = target(params);
    if (!screen || screen.status.current().phase === "archived" || typeof params.data !== "string") {
      return { sent: false };
    }
    void binding.write(screen.session, params.data);
    return { sent: params.data.length };
  });
  register("clear", { view: viewParam }, (params) => {
    const screen = target(params);
    if (!screen || screen.status.current().phase === "archived") return { cleared: false };
    void binding.write(screen.session, "\f");
    return { cleared: true };
  });
  register("focus", { view: viewParam }, (params) => ({
    focused: target(params)?.presenter.focus() ?? false
  }));
  register("recovery-status", { view: viewParam }, (params) => publicStatus(target(params)));
}

// src/index.ts
function activate(context) {
  activateProviderTerminalPlugin(context.app, context.subscriptions, {
    pluginId: "soksak-plugin-terminal-ghostty",
    engineId: "ghostty",
    providerUnit: "terminal-ghostty",
    programId: "terminal-ghostty"
  });
}
export {
  activate
};
