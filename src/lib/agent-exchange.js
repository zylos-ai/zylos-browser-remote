import { AttachmentScope } from "../../scripts/attachments.js";
import { replyCommands } from "../../scripts/reply-route.js";
import { controlLossReceipt } from "./control-loss.js";

// Generic request/response exchange. No action names, page rules or decisions
// are interpreted here. One response can carry the client's next request.
const TERMINAL_KINDS = ["done", "blocked"];

// Task ends the agent did not cause itself. done/blocked follow the agent's
// own final reply, so they never produce a notice.
const NOTICE_STATUSES = ["stopped", "interrupted"];

// Fallback deadline for one decision's execution. It must sit ABOVE the
// extension's own round watchdog (utils/browser-loop.ts roundWatchdogMs), so
// the extension always times a round out first and the relay only catches an
// extension that never reports at all. Mirrors that formula:
//   120s + sum over actions of (max(action.timeoutMs ?? 60s, params.timeoutMs) + 15s)
// plus a 60s margin, capped at 15 minutes. Rounds with lease/consent-driven
// methods have no extension watchdog; they get the cap, so a silent extension
// still cannot hold the waiter forever.
const WATCHDOG_ACTION_MS = 60_000;
const WATCHDOG_SETTLE_MS = 15_000;
const WATCHDOG_SLACK_MS = 120_000;
const EXECUTION_MARGIN_MS = 60_000;
const EXECUTION_CAP_MS = 900_000;
const UNTIMED_METHODS = ["recover-control", "inspect-recovery-frames", "use-current-tab"];
function executionDeadlineMs(decision) {
  const actions = Array.isArray(decision?.actions) ? decision.actions : [];
  if (actions.some((a) => UNTIMED_METHODS.includes(a?.method))) return EXECUTION_CAP_MS;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const watchdog = actions.reduce((total, a) =>
    total + Math.max(num(a?.timeoutMs) || WATCHDOG_ACTION_MS, num(a?.params?.timeoutMs)) + WATCHDOG_SETTLE_MS,
  WATCHDOG_SLACK_MS);
  return Math.min(EXECUTION_CAP_MS, watchdog + EXECUTION_MARGIN_MS);
}

class AgentExchange {
  // push(event): deliver a recovery request or a task-end notice through C4
  // when no reply call is open. Optional; without it nothing is pushed.
  // direct(endpointId, taskId): final replies must bypass c4-send (see
  // scripts/reply-route.js).
  constructor(ext, { push, direct = () => false, log = () => {}, deadlineMs = executionDeadlineMs } = {}) {
    this.ext = ext;
    this.log = log;
    this.deadlineMs = deadlineMs;
    this.push = push;
    this.direct = direct;
    // Which decision produced each receipt: only an identical retry replays it.
    this.signatures = new WeakMap();
    this.states = new Map();
    ext.on("disconnected", (key) => this.disconnected(key));
    ext.on("agent-turn-end", (event) => this.ended(event));
  }
  ingest(message) {
    const { endpointId, chatId, request } = message;
    let state = this.states.get(endpointId);
    if (!state || state.taskId !== chatId) {
      state?.attachments.close();
      if (state?.waiter) {
        clearTimeout(state.waiter.timer);
        state.waiter.resolve({
          ok: false,
          code: "STALE_DECISION",
          message: "Turn was replaced",
        });
      }
      state = {
        taskId: chatId,
        mode: false,
        receipts: new Map(),
        attachments: new AttachmentScope(),
        // Request IDs already delivered as a C4 message (no reply call open).
        pushed: new Set(),
      };
      this.states.set(endpointId, state);
    }
    state.next = {
      ...request,
      endpointId,
      replyCommands: replyCommands(endpointId, request.id, undefined, { direct: this.direct(endpointId, chatId) }),
    };
    if (!state.mode) return false; // First delivery uses the existing C4 adapter.
    if (!state.waiter && state.orphan) {
      // The caller gave up; keep the result so a retry of that request gets it.
      state.waiter = { ...state.orphan, resolve: () => {} };
      state.orphan = undefined;
    }
    if (state.waiter) this.deliver(state);
    else if (this.push && request.execution?.mode === "recovery" && !state.pushed.has(request.id)) {
      // Nobody is waiting (for example the agent is waiting on a human), and a
      // recovery request expires: deliver it now instead of holding it.
      state.pushed.add(request.id);
      try {
        this.push({ kind: "recovery", endpointId, taskId: chatId, request: state.next, attachments: state.attachments });
      } catch { /* best effort; a later reply call still receives it */ }
    }
    return true;
  }
  attachmentsFor({ endpointId, chatId }) {
    const state = this.states.get(endpointId);
    return state?.taskId === chatId ? state.attachments : undefined;
  }
  deliver(state) {
    const waiter = state.waiter;
    if (!waiter) return;
    let response;
    try {
      response = state.terminal
        ? { ok: true, accepted: true, finished: true, status: state.terminal,
            ...(state.interruption ? { interruption: state.interruption } : {}) }
        : state.pushed?.has(state.next?.id)
          // Already delivered as a C4 message: point there, never twice.
          ? { ok: true, accepted: true, deliveredViaC4: state.next.id,
              message: `The next request ${state.next.id} was already delivered as a separate C4 message; answer it with that message's replyCommands` }
          : {
              ok: true,
              accepted: true,
              next: state.attachments.materialize(state.next),
            };
      if (!state.terminal && response.next) state.next = response.next;
    } catch {
      response = {
        ok: false,
        code: "ATTACHMENT_FAILED",
        message:
          "Agent attachment could not be saved; browser input must not be repeated",
      };
    }
    state.receipts.set(waiter.id, response);
    if (waiter.signature) this.signatures.set(response, waiter.signature);
    while (state.receipts.size > 32)
      state.receipts.delete(state.receipts.keys().next().value);
    this.release(state);
    waiter.resolve(response);
  }
  release(state) {
    clearTimeout(state.waiter?.timer);
    state.waiter = null;
  }
  // The caller stopped waiting (its HTTP client closed). Ask the
  // extension to cancel the in-flight execution; later results stay receiptable.
  abandon(endpointId, id, reason = "caller-closed", waiter = this.states.get(endpointId)?.waiter) {
    const state = this.states.get(endpointId);
    if (!waiter || state?.waiter !== waiter || waiter.id !== id) return undefined;
    this.release(state);
    state.orphan = { id, signature: waiter.signature };
    this.ext.request(endpointId, { method: "agent-cancel", params: { id, reason }, timeoutMs: 10000 })
      .catch(() => {}); // Older extensions reject it; the release above still holds.
    return waiter;
  }
  // Execution deadline passed without a report: free the waiter, ask the
  // extension to cancel (agent-cancel, reason execution-timeout), and tell
  // the caller. A later result for this ID stays receiptable.
  expire(endpointId, id, waiter, ms) {
    if (!this.abandon(endpointId, id, "execution-timeout", waiter)) return;
    this.log(`agent[${endpointId}]: decision ${id} exceeded execution deadline ${ms}ms; sent agent-cancel`);
    waiter.resolve({
      ok: false,
      code: "EXECUTION_TIMEOUT",
      message: `The browser did not report within ${Math.round(ms / 1000)}s; the relay asked it to cancel. Actions may have partly run: do not replay them blindly. A new decision is accepted once the browser sends its next request.`,
    });
  }
  async respond(endpointId, id, decision, inputId) {
    const state = this.states.get(endpointId);
    if (!state)
      return {
        ok: false,
        code: "STALE_DECISION",
        message: "No active request on this connection",
      };
    if (state.next?.id !== id && !state.receipts.has(id))
      return {
        ok: false,
        code: "STALE_DECISION",
        message: "Request does not belong to the current exchange",
      };
    // A recovery judgment that arrived after terminal expiry must never send
    // another attach attempt. Prior action receipts keep their existing path.
    if (state.terminal && state.next?.id === id && state.next.execution?.mode === "recovery")
      return { ok: false, code: "RECOVERY_CLOSED", finished: true, status: state.terminal,
        ...(state.interruption ? { interruption: state.interruption } : {}),
        message: "Recovery judgment expired or ended; no action was sent" };
    if (state.waiter && TERMINAL_KINDS.includes(decision?.kind) && state.waiter.id === id) {
      // done/blocked must always reach the extension so the task can close.
      // Release only: a cancel would make the extension move on to a new
      // request before this final decision arrives.
      const replaced = state.waiter;
      this.release(state);
      replaced.resolve({
        ok: false,
        code: "DECISION_SUPERSEDED",
        message: "A done/blocked reply replaced this decision; its actions may have partly run",
      });
    }
    if (state.waiter)
      return {
        ok: false,
        code: "DECISION_BUSY",
        message:
          "A decision is still executing; do not submit concurrent decisions",
      };
    // Arm before forwarding: a very fast client may return its next request
    // before acknowledging receipt of this response.
    state.mode = true;
    const signature = JSON.stringify([decision, inputId ?? null]);
    let mine;
    const next = new Promise((resolve) => {
      // One waiter per endpoint, released by the next request, task end,
      // replacement, disconnect, the caller leaving, or the execution
      // deadline (an extension that never reports must not block the loop).
      state.orphan = undefined;
      state.waiter = mine = { id, resolve, signature };
      const ms = this.deadlineMs(decision);
      mine.timer = setTimeout(() => this.expire(endpointId, id, mine, ms), ms);
      mine.timer.unref?.();
    });
    const previous = state.receipts.get(id);
    try {
      // Client validates both the schema and idempotent contents, including
      // retries whose earlier browser actions have already happened.
      const ack = await this.ext.request(endpointId, {
        method: "agent-decision",
        params: { id, decision, ...(inputId ? { inputId } : {}) },
        timeoutMs: 10000,
      });
      // The extension's normalized comparison wins: replayed:true means it saw
      // the same decision, whatever the key order here.
      const identical = previous && (ack?.replayed === true || this.signatures.get(previous) === signature);
      // A different done/blocked for an answered ID (e.g. after the caller was
      // killed) is a new final decision: wait for its end, never replay.
      const newFinal = previous && !identical && TERMINAL_KINDS.includes(decision?.kind);
      if (identical && (!state.terminal || previous.finished) && state.waiter === mine) {
        this.release(state);
        mine.resolve({ ...previous, replayed: true });
      } else if (state.waiter && (state.terminal || (state.next?.id !== id && !newFinal)))
        this.deliver(state);
    } catch (error) {
      // Compare the object: a later retry of the same ID owns its own waiter.
      if (state.waiter === mine) {
        this.release(state);
        mine.resolve({
          ok: false,
          code: error.code || "EXT_ERROR",
          message: error.message,
          details: error.details,
        });
      }
    }
    return next;
  }
  ended({ endpointId, taskId, status, interruption, text, reason }) {
    const state = this.states.get(endpointId);
    if (!state || state.taskId !== taskId) {
      // No request of this task reached the exchange; only a task an agent
      // started itself is worth a notice (the push handler decides).
      this.notifyEnd({ endpointId, taskId, status, interruption: interruption ? controlLossReceipt(interruption) : undefined, text, ...(reason ? { reason } : {}), known: false });
      return;
    }
    state.terminal = status;
    state.interruption = status === "interrupted" || (status === "stopped" && interruption?.recoveryRemoval !== undefined)
      ? controlLossReceipt(interruption) : undefined;
    state.attachments.close();
    if (state.waiter) this.deliver(state);
    else this.notifyEnd({ endpointId, taskId, status, interruption: state.interruption, text, ...(reason ? { reason } : {}), known: true });
  }
  notifyEnd(event) {
    if (!this.push || !NOTICE_STATUSES.includes(event.status)) return;
    try {
      this.push({ kind: "ended", ...event });
    } catch { /* best effort */ }
  }
  disconnected(endpointId) {
    const state = this.states.get(endpointId);
    this.states.delete(endpointId);
    state?.attachments.close();
    if (state?.waiter) {
      clearTimeout(state.waiter.timer);
      state.waiter.resolve({
        ok: false,
        code: "EXT_OFFLINE",
        message:
          "Browser disconnected; do not replay actions after reconnecting",
      });
    }
  }
  close() {
    for (const key of this.states.keys()) this.disconnected(key);
  }
}
export { AgentExchange, executionDeadlineMs };
