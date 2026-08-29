import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import readline from "node:readline";
import { config, debugLog, log } from "./config.js";
import type { InitializeResponse } from "./protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
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

  async ensureStarted(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  get serverInfo(): InitializeResponse | null {
    return this.initializeResult;
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

    child.on("error", (err) => {
      log(`app-server spawn failed: ${err.message}`);
      this.failAllPending(new Error(`codex app-server failed to start: ${err.message}`));
      this.child = null;
    });

    child.on("exit", (code, signal) => {
      const reason = `codex app-server exited (code=${code} signal=${signal})`;
      if (!this.shuttingDown) log(reason);
      this.failAllPending(new Error(reason));
      this.child = null;
      this.initializeResult = null;
      this.emit("exit", { code, signal });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => debugLog("app-server stderr:", chunk.trimEnd()));

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => this.handleLine(line));

    const initTimer = setTimeout(() => {
      this.failAllPending(new Error("codex app-server did not complete initialize in time"));
      child.kill();
    }, config.startupTimeoutMs);

    try {
      this.initializeResult = (await this.request<InitializeResponse>("initialize", {
        clientInfo: { name: "agent-router", title: "Agent Router MCP", version: "0.1.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      })) as InitializeResponse;
      this.notify("initialized", {});
      debugLog("initialized:", this.initializeResult.userAgent);
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

    // Response to one of our requests.
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(
          new CodexRpcError(
            msg.error.message ?? `${pending.method} failed`,
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
    if (!this.child || this.child.killed) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
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
    this.child?.kill();
    this.child = null;
  }
}
