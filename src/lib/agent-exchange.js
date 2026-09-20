"use strict";
const { materializeImages } = require("../../scripts/attachments");
const { replyCommands } = require("../../scripts/reply-route");

// Generic request/response exchange. No action names, page rules or decisions
// are interpreted here. One response can carry the client's next request.
class AgentExchange {
  constructor(ext) {
    this.ext = ext;
    this.states = new Map();
    ext.on("disconnected", (key) => this.disconnected(key));
    ext.on("agent-turn-end", (event) => this.ended(event));
  }
  ingest(message) {
    const { endpointId, chatId, text, request } = message;
    let state = this.states.get(endpointId);
    if (!state || state.taskId !== chatId) {
      if (state?.waiter)
        state.waiter.resolve({
          ok: false,
          code: "STALE_DECISION",
          message: "Turn was replaced",
        });
      state = { taskId: chatId, mode: false, receipts: new Map() };
      this.states.set(endpointId, state);
    }
    state.next = {
      endpointId,
      id: request.id,
      taskId: chatId,
      round: request.round,
      text,
      payload: request.payload,
      replyCommands: replyCommands(endpointId, request.id),
    };
    if (!state.mode) return false; // First delivery uses the existing C4 adapter.
    if (state.waiter) this.deliver(state);
    return true;
  }
  deliver(state) {
    const waiter = state.waiter;
    if (!waiter) return;
    let response;
    try {
      response = state.terminal
        ? { ok: true, accepted: true, finished: true, status: state.terminal }
        : { ok: true, accepted: true, next: materializeImages(state.next) };
      if (!state.terminal) state.next = response.next;
    } catch {
      response = {
        ok: false,
        code: "ATTACHMENT_FAILED",
        message:
          "Agent attachment could not be saved; browser input must not be repeated",
      };
    }
    state.receipts.set(waiter.id, response);
    while (state.receipts.size > 32)
      state.receipts.delete(state.receipts.keys().next().value);
    state.waiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(response);
  }
  async respond(endpointId, id, decision) {
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
    const next = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (state.waiter?.id !== id) return;
        state.waiter = null;
        resolve({
          ok: false,
          code: "DECISION_WAIT_TIMEOUT",
          message:
            "Execution outcome unknown. Retry this same request ID only; never invent a new action request.",
        });
      }, 120000);
      timer.unref?.();
      state.waiter = { id, resolve, timer };
    });
    const previous = state.receipts.get(id);
    try {
      // Client validates both the schema and idempotent contents, including
      // retries whose earlier browser actions have already happened.
      await this.ext.request(endpointId, {
        method: "agent-decision",
        params: { id, decision },
        timeoutMs: 10000,
      });
      if (previous && state.waiter?.id === id) {
        const waiter = state.waiter;
        state.waiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve({ ...previous, replayed: true });
      } else if (state.waiter && (state.terminal || state.next?.id !== id))
        this.deliver(state);
    } catch (error) {
      const waiter = state.waiter;
      if (waiter?.id === id) {
        state.waiter = null;
        clearTimeout(waiter.timer);
        waiter.resolve({
          ok: false,
          code: error.code || "EXT_ERROR",
          message: error.message,
          details: error.details,
        });
      }
    }
    return next;
  }
  ended({ endpointId, taskId, status }) {
    const state = this.states.get(endpointId);
    if (!state || state.taskId !== taskId) return;
    state.terminal = status;
    if (state.waiter) this.deliver(state);
  }
  disconnected(endpointId) {
    const state = this.states.get(endpointId);
    this.states.delete(endpointId);
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
module.exports = { AgentExchange };
