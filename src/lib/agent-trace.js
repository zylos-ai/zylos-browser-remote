"use strict";
const { ENDPOINT_SOURCE } = require("./endpoint");

// Read-only adapter for the Zylos Codex CLI rollout. Never execute log content,
// copy reasoning, or expose unredacted credentials / raw tool output.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { inputDetails } = require("./monitor-input");
const isExec = (name) => /(?:^|\.)exec_command$/.test(name);
const READ_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 4 * READ_BYTES;

function inputSummary(name, input) {
  let args = input;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = { script: args };
    }
  }
  if (!args || typeof args !== "object") return "参数内容未记录";
  const command = args.cmd || args.command;
  if (typeof command === "string") {
    // Only recognized executable names and browser method names, no shell args.
    const executable = command
      .trim()
      .match(
        /^(?:[\w./-]*\/)?(node|npm|pnpm|python3?|rg|cat|sed|ls|git|curl|bash|sh)\b/,
      )?.[1];
    const decision = /\bdecision\.js\b/.test(command);
    return `执行命令${executable ? ` · ${executable}` : ""}${decision ? " · decision.js" : ""}（${command.length} 字符）`;
  }
  if (name.includes("patch")) return "应用文件补丁（补丁内容未记录）";
  if (args.script || args.code) return "执行工具脚本（脚本内容未记录）";
  // Paths are useful for image/file-read tools; take only a filename, not a URI
  // or directory which could contain credentials. Other argument values stay out.
  const file = args.path || args.file_path || args.filename;
  if (typeof file === "string" && !file.includes("://"))
    return `文件：${path.basename(file).slice(0, 120)}`;
  return `参数：${
    Object.keys(args)
      .slice(0, 12)
      .map((key) => key.slice(0, 60))
      .join("、") || "无"
  }（值未记录）`;
}

function outputSummary(payload) {
  const output = payload.output;
  const raw =
    typeof output === "string"
      ? output
      : JSON.stringify(output ?? payload.tools ?? null);
  let data = output;
  if (typeof output === "string") {
    try {
      data = JSON.parse(output);
    } catch {
      /* CLI text output */
    }
  }
  const exit = raw.match(/(?:Process exited with code|exit code:)\s*(-?\d+)/i);
  const code = Number.isInteger(data?.exit_code)
    ? data.exit_code
    : exit
      ? Number(exit[1])
      : null;
  const failed =
    code !== null
      ? code !== 0
      : data?.isError === true ||
        data?.ok === false ||
        ["failed", "error"].includes(payload.status);
  const running =
    /Process running with session ID|Script running with cell ID/.test(raw) ||
    (data?.session_id != null && code === null);
  const bytes = Buffer.byteLength(raw);
  return {
    status: failed ? "error" : code === 0 ? "success" : "returned",
    outputBytes: bytes,
    error: failed
      ? code !== null
        ? `退出码 ${code}`
        : "工具报告错误"
      : undefined,
    result: `${running ? "工具已返回，后台操作仍在运行" : "工具已返回"}；输出 ${bytes} 字节${code !== null ? `；退出码 ${code}` : ""}。原始输出未记录。`,
  };
}

class RolloutSession {
  constructor(monitor, id, since) {
    this.monitor = monitor;
    this.id = id;
    this.since = since;
    this.run = null;
    this.turn = null;
    this.promptSeen = false;
    this.mixed = false;
    this.pending = new Map();
    this.seen = new Set();
    this.offset = 0;
    this.buffer = Buffer.alloc(0);
    this.skipLine = false;
    this.initialized = false;
  }

  end(at) {
    for (const ticket of this.pending.values())
      this.monitor.agentEnded(
        ticket,
        {
          status: "unknown",
          result: "本轮日志结束，但没有捕获到对应的工具返回。",
        },
        at,
      );
    this.pending.clear();
    this.run = null;
    this.promptSeen = false;
    this.mixed = false;
  }

  event(event) {
    const at = Date.parse(event.timestamp);
    const p = event.payload || {};
    if (!Number.isFinite(at)) return;
    if (at < this.since) return;
    if (event.type === "event_msg") {
      if (p.type === "task_started") {
        this.end(at);
        this.turn = p.turn_id;
      }
      if (
        ["task_complete", "task_interrupted", "turn_aborted"].includes(
          p.type,
        ) &&
        (!p.turn_id || !this.turn || p.turn_id === this.turn)
      )
        this.end(at);
      return;
    }
    if (event.type !== "response_item") return;
    if (p.type === "message" && p.role === "user") {
      const text = (Array.isArray(p.content) ? p.content : [])
        .filter((c) => c.type === "input_text")
        .map((c) => c.text || "")
        .filter(
          (text) =>
            !/^(?:# AGENTS\.md instructions|<environment_context>|<skill>)/.test(
              text.trim(),
            ),
        )
        .join("\n");
      if (!text.trim()) return;
      // C4's 100-character preview can cut off the request ID. The complete
      // endpoint precedes it; only recognize it in the transport header.
      const endpoint = text.match(
        new RegExp(
          `(?:^|\\n|Meanwhile, )\\[Browser\\] \\[Extension decision request (${ENDPOINT_SOURCE})/`,
        ),
      )?.[1];
      const tokens = [
        ...text.matchAll(
          /(?:^|\n|Meanwhile, )\[Browser\] \[Activity ([a-f0-9-]{36})\]/g,
        ),
      ].map((m) => m[1]);
      const uniqueTokens = [...new Set(tokens)];
      const next = uniqueTokens.length
        ? uniqueTokens.length === 1
          ? (this.monitor.agentActivityRun?.(uniqueTokens[0], at) ?? null)
          : null
        : endpoint
          ? this.monitor.agentRun(endpoint, at)
          : null;
      if (this.promptSeen && this.run !== next) {
        this.mixed = true;
        if (this.run) {
          this.run.agentMixed = true;
          this.monitor.changed();
        }
        if (next) {
          next.agentMixed = true;
          this.monitor.changed();
        }
      }
      this.promptSeen = true;
      this.run = this.mixed ? null : next;
      if (this.run) this.monitor.agentInputObserved?.(this.run, at);
      if (next) {
        next.agentObserved = true;
        if (
          !next.steps.some(
            (step) =>
              step.kind === "agent-input" &&
              step.sessionId === this.id &&
              step.startedAt === at,
          )
        ) {
          this.monitor.add(next, "agent-input", "Agent 实际收到的消息", {
            startedAt: at,
            sessionId: this.id,
            turnId: this.turn,
            invocation:
              this.monitor.captureInputs === false
                ? undefined
                : inputDetails(text),
          });
        }
      }
      return;
    }
    const starts = [
      "function_call",
      "custom_tool_call",
      "tool_search_call",
      "web_search_call",
    ];
    const ends = [
      "function_call_output",
      "custom_tool_call_output",
      "tool_search_output",
    ];
    const id = p.call_id || p.id;
    if (!id) return;
    if (starts.includes(p.type)) {
      if (!this.run || this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 1000)
        this.seen.delete(this.seen.values().next().value);
      const name = String(p.name || p.type.replace(/_call$/, "")).slice(0, 160);
      const ticket = this.monitor.agentStarted(this.run, {
        name,
        callId: id,
        sessionId: this.id,
        turnId: this.turn,
        params:
          this.monitor.captureInputs === false
            ? undefined
            : inputSummary(name, p.arguments ?? p.input ?? p.action),
        activity: this.monitor.describeTool?.(
          name,
          p.arguments ?? p.input ?? p.action,
        ),
        invocation:
          this.monitor.captureInputs !== false && isExec(name)
            ? inputDetails(p.arguments ?? p.input)
            : undefined,
        at,
      });
      if (this.pending.size >= 120) {
        const oldest = this.pending.keys().next().value;
        this.monitor.agentEnded(
          this.pending.get(oldest),
          { status: "unknown", result: "未返回的调用过多，已停止跟踪此调用。" },
          at,
        );
        this.pending.delete(oldest);
      }
      this.pending.set(id, ticket);
      // Native web search has no separate output record.
      if (
        p.type === "web_search_call" &&
        ["completed", "failed"].includes(p.status)
      ) {
        this.monitor.agentEnded(ticket, outputSummary(p), at);
        this.pending.delete(id);
      }
    } else if (ends.includes(p.type) && this.pending.has(id)) {
      this.monitor.agentEnded(this.pending.get(id), outputSummary(p), at);
      this.pending.delete(id);
    }
  }

  read(file) {
    const stat = fs.statSync(file);
    if (!this.initialized) {
      // Existing steps can precede large screenshot results. Scan a bounded
      // history window in the same 1 MiB chunks, only when details are missing.
      this.offset = Math.max(0, stat.size - READ_BYTES);
      this.skipLine = this.offset > 0;
      this.inode = stat.ino;
      this.initialized = true;
    } else if (stat.size < this.offset || stat.ino !== this.inode) {
      this.end(this.monitor.now?.() ?? Date.now());
      this.offset = 0;
      this.buffer = Buffer.alloc(0);
      this.skipLine = false;
      this.inode = stat.ino;
    }
    const length = Math.min(READ_BYTES, stat.size - this.offset);
    if (!length) return;
    const chunk = Buffer.alloc(length),
      fd = fs.openSync(file, "r");
    let bytes;
    try {
      bytes = fs.readSync(fd, chunk, 0, length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset += bytes;
    const data = Buffer.concat([this.buffer, chunk.subarray(0, bytes)]);
    let start = 0,
      newline;
    while ((newline = data.indexOf(10, start)) !== -1) {
      if (this.skipLine) this.skipLine = false;
      else if (newline - start <= MAX_LINE_BYTES) {
        let record;
        try {
          record = JSON.parse(data.subarray(start, newline).toString("utf8"));
        } catch {
          this.monitor.logGap?.(this); // Uncertain records cannot preserve task attribution.
        }
        if (record) this.event(record);
      } else this.monitor.logGap?.(this);
      start = newline + 1;
    }
    this.buffer = Buffer.from(data.subarray(start));
    if (this.buffer.length > MAX_LINE_BYTES) {
      this.monitor.logGap?.(this);
      this.buffer = Buffer.alloc(0);
      this.skipLine = true;
    }
  }
}

class AgentTrace {
  constructor(
    monitor,
    {
      directory,
      codexDirectory = process.env.CODEX_HOME ||
        path.join(os.homedir(), ".codex"),
      discover,
    } = {},
  ) {
    this.monitor = monitor;
    this.directory = directory;
    this.codexDirectory = codexDirectory;
    this.sessions = new Map();
    this.since = monitor.startedAt;
    this.closed = false;
    this.discover = discover || (() => this.findSessions());
  }

  state(status, message) {
    const next = { status, message, runtime: "codex" };
    if (JSON.stringify(next) !== JSON.stringify(this.monitor.agentSource)) {
      this.monitor.agentSource = next;
      this.monitor.changed();
    }
  }

  async findSessions() {
    const runtime = JSON.parse(
      fs.readFileSync(path.join(this.directory, ".zylos/config.json"), "utf8"),
    ).runtime;
    if (runtime !== "codex") {
      const error = new Error("unsupported");
      error.code = "UNSUPPORTED_RUNTIME";
      throw error;
    }
    const cwd = fs.realpathSync(this.directory).replace(/'/g, "''");
    const { stdout } = await execFileAsync(
      "sqlite3",
      [
        "-readonly",
        "-json",
        path.join(this.codexDirectory, "state_5.sqlite"),
        `SELECT id,rollout_path FROM threads WHERE archived=0 AND source='cli' AND cwd='${cwd}' ORDER BY updated_at DESC LIMIT 4;`,
      ],
      { encoding: "utf8", timeout: 1500, maxBuffer: 256 * 1024 },
    );
    return JSON.parse(stdout || "[]");
  }

  async poll() {
    try {
      const rows = await this.discover();
      if (this.closed) return;
      const ids = new Set(rows.map((row) => row.id));
      for (const [id, session] of this.sessions)
        if (!ids.has(id)) {
          session.end(this.monitor.now());
          this.sessions.delete(id);
        }
      let readable = 0;
      for (const row of rows) {
        let session = this.sessions.get(row.id);
        if (!session) {
          session = new RolloutSession(this.monitor, row.id, this.since);
          this.sessions.set(row.id, session);
        }
        try {
          session.read(row.rollout_path);
          readable++;
        } catch {
          /* a rotated or unavailable file must not affect relay */
        }
      }
      this.state(
        readable ? "connected" : "waiting",
        readable
          ? "Agent 工具采集已连接 · Codex CLI"
          : "等待 Zylos Agent 的会话日志",
      );
    } catch (error) {
      if (!this.closed)
        this.state(
          "unavailable",
          error.code === "UNSUPPORTED_RUNTIME"
            ? "当前 Agent 运行时暂不支持工具采集；浏览器调用仍正常记录"
            : "Agent 日志暂不可读；请检查运行目录、Codex 日志与 sqlite3",
        );
    }
  }

  start() {
    const poll = async () => {
      await this.poll();
      if (!this.closed) {
        this.timer = setTimeout(poll, 1000);
        this.timer.unref();
      }
    };
    void poll();
    return this;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }
}

module.exports = { AgentTrace, RolloutSession, inputSummary, outputSummary };
