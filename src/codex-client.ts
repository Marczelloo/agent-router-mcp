import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import readline from "node:readline";
import { config, debugLog, log, VERSION } from "./config.js";
import type { InitializeResponse } from "./protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
  /** The app-server process the request was sent to. */
  generation: number;
}

/**
 * Codex reports a missing login as a bare "authentication required", which tells
 * the caller what is wrong but not what to do. The fix is always the same.
 */
function explainError(message: string): string {
  if (/authentication required|not logged in|unauthorized/i.test(message)) {
    return `${message}. Run \`codex login\` (or set an OpenAI API key) and try again.`;
  }
  return message;
}

export class CodexRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

/**
 * Persistent `codex app-server` child process wrapped in a JSON-RPC client.
 *
 * One process serves every thread; threads are addressed by id, so delegating a
 * second task never pays the startup cost again. Notifications are re-emitted on
 * this emitter as `notification` and as `notification:<method>`.
 */
export class CodexClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private pending = new Map<number, PendingRequest>();
  private nextId = 0;
  private initializeResult: InitializeResponse | null = null;
  private shuttingDown = false;
  private restarting = false;
  private startedAt: number | null = null;
  private restarts = 0;
  /**
   * Each spawned process gets a generation. Requests are tagged with the one
   * they were sent to, so the death of a replaced process — which can come
   * seconds after its successor started — fails only its own requests.
   */
  private generation = 0;
  private generations = new WeakMap<ChildProcessWithoutNullStreams, number>();
  private retiredProcesses = new WeakSet<ChildProcessWithoutNullStreams>();

  async ensureStarted(): Promise<void> {
    // `this.child` is set as soon as the process spawns, before the handshake;
    // a concurrent caller must wait for the handshake, not just the process.
    if (this.starting) return this.starting;
    if (this.child && !this.child.killed && this.initializeResult) return;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  get serverInfo(): InitializeResponse | null {
    return this.initializeResult;
  }

  info(): {
    running: boolean;
    pid: number | null;
    startedAt: string | null;
    uptimeSeconds: number | null;
    pendingRequests: number;
    restarts: number;
    userAgent: string | null;
    codexHome: string | null;
  } {
    const running = Boolean(this.child && !this.child.killed && this.initializeResult);
    return {
      running,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      uptimeSeconds: running && this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : null,
      pendingRequests: this.pending.size,
      restarts: this.restarts,
      userAgent: this.initializeResult?.userAgent ?? null,
      codexHome: this.initializeResult?.codexHome ?? null,
    };
  }

  /**
   * Replace a wedged app-server with a fresh one. Threads live on disk, so they
   * survive this and can be resumed; only turns in flight are lost.
   */
  async restart(): Promise<void> {
    const old = this.child;
    if (old) {
      this.restarting = true;
      const exited = new Promise<void>((resolve) => old.once("exit", () => resolve()));
      killTree(old);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      // If it has not exited yet, treat it as gone now; its eventual exit event
      // will find it already retired and leave the new process alone.
      this.retireProcess(old, "codex app-server was restarted");
      this.restarting = false;
    }
    this.restarts++;
    await this.ensureStarted();
  }

  /**
   * Account for a process that is gone: fail the requests sent to it and, if it
   * was the current one, report the exit. Runs at most once per process.
   */
  private retireProcess(child: ChildProcessWithoutNullStreams, reason: string, code?: number | null, signal?: string | null): void {
    if (this.retiredProcesses.has(child)) return;
    this.retiredProcesses.add(child);
    const deliberate = this.shuttingDown || this.restarting;
    if (!deliberate) log(reason);
    this.failAllPending(new Error(reason), this.generations.get(child));
    if (this.child !== child) return; // already replaced; nothing current depends on it
    this.child = null;
    this.initializeResult = null;
    this.emit("exit", { code: code ?? null, signal: signal ?? null, deliberate });
  }

  private async start(): Promise<void> {
    debugLog("spawning", config.codexBin, config.codexArgs.join(" "));
    const child = spawn(config.codexBin, config.codexArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      // `codex` resolves through a .cmd shim on Windows and needs a shell, but
      // an explicit absolute binary must not go through one: cmd.exe would
      // mangle any path containing spaces.
      shell: process.platform === "win32" && !path.isAbsolute(config.codexBin),
      env: process.env,
    });
    this.child = child;
    this.startedAt = Date.now();
    this.generations.set(child, ++this.generation);

    child.on("error", (err) => {
      this.retireProcess(child, `codex app-server failed to start: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      this.retireProcess(child, `codex app-server exited (code=${code} signal=${signal})`, code, signal);
    });

    // A pipe error (EPIPE when the process dies mid-write) is emitted on the
    // stream, not the child; unhandled, it would take the whole MCP server down.
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream.on("error", (err) => {
        debugLog("app-server pipe error:", err.message);
        this.retireProcess(child, `codex app-server pipe failed: ${err.message}`);
        killTree(child);
      });
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => debugLog("app-server stderr:", chunk.trimEnd()));

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      // A listener that throws must cost one message, not the process.
      try {
        this.handleLine(line);
      } catch (err) {
        log(`could not handle app-server message: ${(err as Error).message}`);
      }
    });

    const initTimer = setTimeout(() => {
      this.retireProcess(child, "codex app-server did not complete initialize in time");
      killTree(child);
    }, config.startupTimeoutMs);

    try {
      this.initializeResult = (await this.request<InitializeResponse>("initialize", {
        clientInfo: { name: "agent-router", title: "Agent Router MCP", version: VERSION },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })) as InitializeResponse;
      this.notify("initialized", {});
      debugLog("initialized:", this.initializeResult.userAgent);
    } catch (err) {
      // A process that failed its handshake is not usable; drop it so the next
      // call starts a fresh one instead of talking to a half-open server.
      this.retireProcess(child, `codex app-server failed to initialize: ${(err as Error).message}`);
      killTree(child);
      throw err;
    } finally {
      clearTimeout(initTimer);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: any;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      debugLog("non-JSON line from app-server:", trimmed.slice(0, 200));
      return;
    }
    if (!msg || typeof msg !== "object") {
      debugLog("non-object message from app-server:", trimmed.slice(0, 200));
      return;
    }

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(
          new CodexRpcError(
            explainError(msg.error.message ?? `${pending.method} failed`),
            msg.error.code,
            msg.error.data,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // Server -> client request (approvals, elicitations).
    if (msg.id !== undefined && msg.method) {
      this.handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }

    // Notification.
    if (msg.method) {
      this.emit("notification", msg.method, msg.params);
      this.emit(`notification:${msg.method}`, msg.params);
    }
  }

  /**
   * Codex is headless here: no human is available to answer approvals. We reply
   * immediately so a turn never hangs, declining unless auto-approve is on.
   */
  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    debugLog("server request:", method);
    const approve = config.autoApprove;
    let result: unknown;
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
        result = { decision: approve ? "acceptForSession" : "decline" };
        break;
      case "execCommandApproval":
      case "applyPatchApproval":
        result = {
          decision: approve
            ? "approved_for_session"
            : { denied: { rejection: "Agent Router runs Codex headless; approvals are disabled." } },
        };
        break;
      case "item/tool/requestUserInput":
      case "mcpServer/elicitation/request":
        result = { action: "decline" };
        break;
      default:
        this.respondError(id, `agent-router cannot service ${method} headlessly`);
        return;
    }
    this.respond(id, result);
  }

  private respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  private respondError(id: number | string, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code: -32601, message } });
  }

  private write(payload: unknown): void {
    if (!this.child || this.child.killed || !this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /** Fail pending requests — all of them, or only those sent to one process. */
  private failAllPending(error: Error, generation?: number): void {
    for (const [id, pending] of this.pending) {
      if (generation !== undefined && pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /** Send a JSON-RPC request. `initialize` is allowed before the handshake completes. */
  async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (method !== "initialize") await this.ensureStarted();
    if (!this.child) throw new Error("codex app-server is not running");
    const id = ++this.nextId;
    const budget = timeoutMs ?? config.requestTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out after ${budget}ms: ${method}`));
      }, budget);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
        generation: this.generation,
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  dispose(): void {
    this.shuttingDown = true;
    this.failAllPending(new Error("agent-router shutting down"));
    if (this.child) killTree(this.child);
    this.child = null;
  }
}

/**
 * On Windows `codex` is launched through a shell, so `child.kill()` only ends
 * cmd.exe and can orphan the real app-server. Kill the whole tree instead.
 */
function killTree(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill();
  }
}
