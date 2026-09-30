import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentTrace, RolloutSession } from "./agent-trace.js";
import { redactText } from "./monitor-input.js";
const CAPABILITY = "agent-activity-v1";
const HISTORY_CAPABILITY = "agent-history-v1";
const HISTORY_BATCH = 100;
const HISTORY_BUFFER = 500;
const publicTools = new Set([
  "exec_command",
  "write_stdin",
  "exec",
  "wait",
  "apply_patch",
  "view_image",
  "read_file",
  "write_file",
  "list_files",
  "search",
  "web_search",
  "web_search_call",
  "tool_search",
  "tool_search_call",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TodoWrite",
]);
function publicText(text) {
  if (typeof text !== "string") return "";
  const clean = redactText(text)
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  return clean.length > 2000 ? clean.slice(0, 1998) + "\n…" : clean;
}

// Only fixed categories and allowlisted executable names cross the wire. Never
// send arguments, file names, model reasoning, stdout or an arbitrary tool name.
function describeTool({ name = "", input }) {
  let args = input;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  const command =
    args && typeof args === "object" && (args.cmd || args.command);
  if (typeof command === "string") {
    const executable = command
      .trim()
      .match(
        /^(?:[\w./-]*\/)?(node|npm|pnpm|python3?|rg|cat|sed|ls|git|curl|bash|sh)\b/,
      )?.[1];
    return {
      category: "command",
      ...(executable ? { detail: executable } : {}),
    };
  }
  if (/wait|write_stdin/i.test(name)) return { category: "waiting" };
  if (/search|find|grep|glob/i.test(name))
    return { category: /web/i.test(name) ? "web" : "search" };
  if (/image|screenshot/i.test(name)) return { category: "image" };
  if (/read|view|open_file/i.test(name)) return { category: "read" };
  if (/write|edit|patch/i.test(name)) return { category: "write" };
  if (/web|fetch|browse/i.test(name)) return { category: "web" };
  if (/agent|delegate/i.test(name)) return { category: "delegate" };
  if (/exec|bash|shell/i.test(name)) return { category: "command" };
  return { category: "tool" };
}

// Reuse the bounded JSONL reader and tool-call pairing. Claude's root transcript
// is normalized here; side agents and thinking blocks are deliberately ignored.
class ActivitySession extends RolloutSession {
  constructor(monitor, id, since, runtime) {
    super(monitor, id, since);
    this.runtime = runtime;
    this.records = new Set();
  }
  event(record) {
    const at = Date.parse(record.timestamp);
    if (
      !Number.isFinite(at) ||
      at < this.since ||
      at > this.monitor.now() + 5000
    )
      return;
    if (
      record.isSidechain ||
      (record.sessionId && record.sessionId !== this.id)
    )
      return;
    if (this.runtime !== "claude") {
      super.event(record);
      const p = record.payload;
      // Only the user-facing commentary channel. Never analysis, reasoning
      // records, encrypted content, final answers or tool output.
      if (
        record.type === "response_item" &&
        p?.type === "message" &&
        p.role === "assistant" &&
        (p.channel === "commentary" ||
          (!p.channel && p.phase === "commentary")) &&
        Array.isArray(p.content)
      ) {
        const text = p.content
          .filter((c) => c.type === "output_text")
          .map((c) => c.text)
          .join("\n");
        this.monitor.commentary(
          this.run,
          `${this.id}:${p.id || at}:text`,
          text,
          at,
        );
      }
      return;
    }
    if (record.uuid) {
      if (this.records.has(record.uuid)) return;
      this.records.add(record.uuid);
      if (this.records.size > 1000)
        this.records.delete(this.records.values().next().value);
    }
    const message = record.message;
    if (!message || !["user", "assistant"].includes(record.type)) return;
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    if (!Array.isArray(content)) return;
    const feed = (payload) =>
      super.event({
        timestamp: record.timestamp,
        type: "response_item",
        payload,
      });
    if (
      record.type === "user" &&
      !content.some((c) => c.type === "tool_result")
    ) {
      if (!this.pending.size) this.end(Date.parse(record.timestamp));
      feed({
        type: "message",
        role: "user",
        content: content
          .filter((c) => c.type === "text")
          .map((c) => ({ type: "input_text", text: c.text })),
      });
    }
    for (const [index, item] of content.entries()) {
      if (record.type === "assistant" && item.type === "text")
        this.monitor.commentary(
          this.run,
          `${this.id}:${record.uuid || at}:${index}:text`,
          item.text,
          at,
        );
      if (record.type === "assistant" && item.type === "tool_use")
        feed({
          type: "function_call",
          call_id: item.id,
          name: item.name,
          arguments: item.input,
        });
      if (record.type === "user" && item.type === "tool_result")
        feed({
          type: "function_call_output",
          call_id: item.tool_use_id,
          output: { isError: item.is_error },
        });
    }
  }
  end(at) {
    if (this.run) this.monitor.clear(this.run, at);
    super.end(at);
  }
}

class AgentActivity {
  constructor(
    ext,
    {
      directory = process.env.BROWSER_REMOTE_AGENT_DIR ||
        process.env.ZYLOS_DIR ||
        path.join(os.homedir(), "zylos"),
      codexDirectory,
      claudeDirectory = path.join(os.homedir(), ".claude"),
      discover,
      now = Date.now,
    } = {},
  ) {
    this.ext = ext;
    this.directory = directory;
    this.claudeDirectory = claudeDirectory;
    this.now = now;
    this.bindings = new Map();
    this.sessions = new Map();
    this.startedAt = now();
    this.captureInputs = false;
    this.trace = new AgentTrace(this, { directory, codexDirectory });
    this.discover = discover || (() => this.findSessions());
    this.rows = [];
    this.nextDiscovery = 0;
  }
  describeTool(name, input) {
    return describeTool({ name, input });
  }
  logGap(session) {
    session.end(this.now());
  }
  changed() {
    for (const run of this.bindings.values())
      if (run.agentMixed) this.clear(run, this.now());
  }
  agentRun() {
    return null;
  } // Never attribute by endpoint or by guessing.
  agentActivityRun(token, at) {
    return (
      [...this.bindings.values()].find(
        (b) =>
          b.token === token &&
          at >= b.startedAt &&
          at <= this.now() + 5000 &&
          this.valid(b),
      ) || null
    );
  }
  valid(binding) {
    const conn = this.ext.conns.get(binding.endpointId);
    return (
      this.bindings.get(binding.endpointId) === binding &&
      conn === binding.conn &&
      conn.agentTurn === binding.taskId &&
      this.ext.isConnected(binding.endpointId)
    );
  }
  bind(msg) {
    const conn = this.ext.conns.get(msg.endpointId);
    if (!conn?.capabilities.includes(CAPABILITY)) return;
    const previous = this.bindings.get(msg.endpointId);
    if (previous?.taskId === msg.request.taskId && previous.conn === conn)
      return previous.token;
    if (this.bindings.size >= 100 && !previous) return;
    this.bindings.set(msg.endpointId, {
      endpointId: msg.endpointId,
      taskId: msg.request.taskId,
      conn,
      token: randomUUID(),
      startedAt: this.now(),
      sequence: 0,
      steps: [],
      pending: new Map(),
      history: new Map(),
      historyDropped: 0,
      commentarySeen: new Set(),
    });
    return this.bindings.get(msg.endpointId).token;
  }
  unbind(endpointId) {
    this.bindings.delete(endpointId);
  }
  add() {}
  history(run, event) {
    if (
      !run ||
      run.agentMixed ||
      !this.valid(run) ||
      !run.conn.capabilities.includes(HISTORY_CAPABILITY) ||
      event.at < run.startedAt ||
      event.at > this.now() + 5000
    )
      return;
    run.history.set(event.id, event);
    while (run.history.size > HISTORY_BUFFER) {
      run.history.delete(run.history.keys().next().value);
      run.historyDropped++;
    }
    run.dirty = true;
  }
  commentary(run, id, text, at) {
    if (!run || run.commentarySeen.has(id)) return;
    const cleaned = publicText(text);
    if (!cleaned) return;
    run.commentarySeen.add(id);
    if (run.commentarySeen.size > 1000)
      run.commentarySeen.delete(run.commentarySeen.values().next().value);
    this.history(run, { id, kind: "commentary", text: cleaned, at });
    this.update(run, { category: "processing" }, at);
  }
  agentInputObserved(run, at) {
    run.agentMixed = false;
    this.update(run, { category: "processing" }, at);
  }
  update(run, activity, at) {
    if (
      !this.valid(run) ||
      at < run.startedAt ||
      at < (run.at || 0) ||
      at > this.now() + 5000
    )
      return;
    run.at = at;
    run.latest = activity;
    run.dirty = true;
  }
  clear(run, at) {
    run.pending.clear();
    this.update(run, { category: "idle" }, at);
  }
  agentStarted(run, event) {
    const ticket = {
      run,
      id: `${event.sessionId}:${event.callId}`,
      activity: event.activity || describeTool(event),
    };
    const name = event.name.split(".").at(-1);
    ticket.event = {
      id: ticket.id,
      kind: "tool",
      at: event.at,
      ...ticket.activity,
      ...(publicTools.has(name) ? { tool: name } : {}),
    };
    this.history(run, ticket.event);
    if (run.pending.size >= 120)
      run.pending.delete(run.pending.keys().next().value);
    run.pending.set(ticket.id, ticket);
    this.update(run, ticket.activity, event.at);
    return ticket;
  }
  agentEnded(ticket, result, at) {
    if (!ticket) return;
    const run = ticket.run;
    if (result.status !== "unknown")
      this.history(run, { ...ticket.event, endedAt: at });
    run.pending.delete(ticket.id);
    const latest = [...run.pending.values()].at(-1);
    this.update(
      run,
      latest?.activity ||
        (result.status === "unknown"
          ? { category: "idle" }
          : { ...ticket.activity, phase: "returned" }),
      at,
    );
  }
  flush() {
    for (const run of this.bindings.values()) {
      // A mixed-channel turn cannot safely be attributed to either browser.
      if (run.agentMixed) {
        run.latest = { category: "idle" };
        run.history.clear();
        run.historyDropped = 0;
      }
      if (!run.dirty || !this.valid(run)) continue;
      const events = [...run.history.values()].slice(0, HISTORY_BATCH);
      for (const event of events) run.history.delete(event.id);
      run.dirty = run.history.size > 0;
      this.ext._send(run.conn, {
        type: "agent-activity",
        endpointId: run.endpointId,
        taskId: run.taskId,
        sequence: ++run.sequence,
        ...(run.latest || { category: "processing" }),
        ...(events.length ? { events } : {}),
        ...(run.historyDropped ? { dropped: run.historyDropped } : {}),
      });
      run.historyDropped = 0;
    }
  }
  async findSessions() {
    const runtime = JSON.parse(
      fs.readFileSync(path.join(this.directory, ".zylos/config.json"), "utf8"),
    ).runtime;
    if (runtime === "codex")
      return (await this.trace.findSessions()).map((row) => ({
        ...row,
        runtime,
      }));
    if (!["claude", "claude-code"].includes(runtime)) return [];
    const cwd = fs.realpathSync(this.directory);
    const folders = new Set([
      cwd.replace(/\//g, "-"),
      cwd.replace(/[^a-zA-Z0-9]/g, "-"),
    ]);
    const rows = [];
    for (const folder of folders) {
      const dir = path.join(this.claudeDirectory, "projects", folder);
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!/^[a-f0-9-]{36}\.jsonl$/.test(file)) continue;
        const rollout_path = path.join(dir, file);
        const stat = fs.statSync(rollout_path);
        if (stat.mtimeMs >= this.startedAt - 5000)
          rows.push({
            id: file.slice(0, -6),
            rollout_path,
            runtime: "claude",
            updatedAt: stat.mtimeMs,
          });
      }
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
  }
  async poll() {
    if (!this.bindings.size) {
      this.sessions.clear();
      this.rows = [];
      this.nextDiscovery = 0;
      return;
    }
    try {
      if (this.now() >= this.nextDiscovery) {
        this.rows = (await this.discover()).slice(0, 4);
        this.nextDiscovery = this.now() + 5000;
      }
      if (this.closed) return;
      const ids = new Set(this.rows.map((row) => row.id));
      for (const [id, session] of this.sessions)
        if (!ids.has(id)) {
          session.end(this.now());
          this.sessions.delete(id);
        }
      for (const row of this.rows) {
        let session = this.sessions.get(row.id);
        if (!session) {
          session = new ActivitySession(
            this,
            row.id,
            this.startedAt,
            row.runtime,
          );
          this.sessions.set(row.id, session);
        }
        try {
          session.read(row.rollout_path);
        } catch {
          session.end(this.now());
          this.sessions.delete(row.id);
        }
      }
    } catch {
      for (const session of this.sessions.values()) session.end(this.now());
      this.sessions.clear();
      this.nextDiscovery = this.now() + 5000;
    }
    this.flush();
  }
  start() {
    const tick = async () => {
      await this.poll();
      if (!this.closed) {
        this.timer = setTimeout(tick, 750);
        this.timer.unref();
      }
    };
    void tick();
    return this;
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.bindings.clear();
    this.sessions.clear();
  }
}
export { AgentActivity, ActivitySession, CAPABILITY, HISTORY_CAPABILITY, describeTool };
