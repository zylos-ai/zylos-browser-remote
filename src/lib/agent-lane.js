// Agent-host HTTP entry: decisions and read-only diagnostics.
import http from "http";
import { detailParams, detailResult, DETAIL_CAPABILITY } from "./detail-diagnostics.js";
import { diagnosticParams, diagnosticResult, DIAGNOSTICS_CAPABILITY, DIAGNOSTICS_TIMEOUT_MS } from "./diagnostics.js";

const BIND = "127.0.0.1";
const BODY_LIMIT_BYTES = 256 * 1024; // params can carry a selector list, not a screenshot
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const RELAY_ERROR_STATUS = {
  EXT_OFFLINE: 503,
  EXT_TIMEOUT: 504,
  AMBIGUOUS_ENDPOINT: 400,
  BAD_ENDPOINT: 400,
  UNKNOWN_ENDPOINT: 404,
};

class AgentLane {
  constructor({
    extLane,
    port,
    log = () => {},
    monitor = null,
    exchange = null,
    incidentEvidence = null,
  }) {
    this.ext = extLane;
    this.port = port;
    this.log = log;
    this.monitor = monitor;
    this.exchange = exchange;
    this.incidentEvidence = incidentEvidence;
    this.server = http.createServer((req, res) => this._onHttp(req, res));
  }

  listen() {
    return new Promise((resolve) =>
      this.server.listen(this.port, BIND, resolve),
    );
  }

  async _onHttp(req, res) {
    const url = new URL(req.url, "http://localhost");
    const reply = (status, obj) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=UTF-8",
      });
      res.end(JSON.stringify(obj));
    };
    const fail = (status, code, message, extra) =>
      reply(status, { ok: false, code, message, ...extra });

    try {
      if (this.monitor?.handle(req, res, url, this.ext.status())) return;
      if (req.method === "GET" && url.pathname === "/status") {
        return reply(200, { ok: true, extensions: this.ext.status() });
      }

      if (req.method === "POST" && url.pathname === "/diagnostics/detail") {
        let body;
        try { body = await readJson(req, 4096); detailParams(body); }
        catch { return fail(400, "BAD_REQUEST", "An exact endpoint and no other fields are required"); }
        // This path never enters task recovery, tracing, or the generic metadata export.
        try {
          const target = this.ext.resolve(body.endpoint);
          if (target.error) return fail(RELAY_ERROR_STATUS[target.error] || 503, target.error, "Browser unavailable");
          if (!this.ext.status()[target.endpointId]?.capabilities.includes(DETAIL_CAPABILITY)) {
            return fail(409, "DETAIL_SHARE_UNSUPPORTED", "This browser does not support detailed diagnostic sharing");
          }
          const raw = await this.ext.request(target.endpointId, {
            method: "diagnostics.detail.fetch", params: {}, timeoutMs: 5000,
          });
          let result;
          try { result = detailResult(raw); }
          catch { return fail(502, "BAD_DETAIL_RESPONSE", "Invalid detailed diagnostics response"); }
          res.setHeader("cache-control", "no-store");
          const bundle = JSON.parse(result.text);
          let remoteEvidence;
          // Companion collection must not discard the already consumed, valid grant.
          try {
            remoteEvidence = bundle.schemaVersion === 2 && this.incidentEvidence
              ? this.incidentEvidence.snapshot(target.endpointId, bundle) : undefined;
          } catch { /* An absent companion is an explicit gap in the incident report. */ }
          return reply(200, { ok: true, endpointId: target.endpointId, ...result, ...(remoteEvidence ? { remoteEvidence } : {}) });
        } catch (err) {
          const code = ["EXT_OFFLINE", "EXT_TIMEOUT", "DETAIL_SHARE_UNAVAILABLE"].includes(err.code) ? err.code : "DETAIL_SHARE_ERROR";
          return fail(RELAY_ERROR_STATUS[code] || (code === "DETAIL_SHARE_UNAVAILABLE" ? 409 : 502), code, "Detailed diagnostic retrieval failed; do not retry automatically");
        }
      }

      if (req.method === "POST" && url.pathname === "/diagnostics") {
        let body, params;
        try {
          body = await readJson(req, 4096);
          params = diagnosticParams(body);
        } catch (err) {
          return fail(/too large/.test(err.message) ? 413 : 400, "BAD_REQUEST", err.message);
        }
        const target = this.ext.resolve(body.endpoint);
        if (target.error) return fail(RELAY_ERROR_STATUS[target.error] || 500, target.error, target.message);
        if (!this.ext.status()[target.endpointId]?.capabilities.includes(DIAGNOSTICS_CAPABILITY)) {
          return fail(409, "DIAGNOSTICS_UNSUPPORTED", "This browser does not support diagnostics retrieval");
        }
        let result;
        try {
          result = await this.ext.request(target.endpointId, {
            method: "diagnostics.get", params, timeoutMs: DIAGNOSTICS_TIMEOUT_MS,
          });
        } catch (err) {
          const code = ["EXT_OFFLINE", "EXT_TIMEOUT", "DIAGNOSTICS_RESET", "BAD_PARAMS"].includes(err.code) ? err.code : "DIAGNOSTICS_ERROR";
          return fail(RELAY_ERROR_STATUS[code] || (code === "DIAGNOSTICS_RESET" ? 409 : code === "BAD_PARAMS" ? 400 : 502), code, "Diagnostics retrieval failed");
        }
        try {
          const page = diagnosticResult(result, params.limit);
          if ((params.epoch !== undefined && page.epoch !== params.epoch) ||
              (params.through !== undefined && page.highWater !== params.through) ||
              page.nextCursor < params.after ||
              page.events.some(event => event.seq <= params.after ||
                ["level", "source", "task"].some(name => params[name] !== undefined && event[name] !== params[name]))) {
            return fail(502, "BAD_DIAGNOSTICS_RESPONSE", "Diagnostics response does not match the query");
          }
          return reply(200, { ok: true, endpointId: target.endpointId, ...page });
        } catch {
          return fail(502, "BAD_DIAGNOSTICS_RESPONSE", "Invalid diagnostics response");
        }
      }

      if (req.method === "POST" && url.pathname === "/decision") {
        let body;
        try {
          body = await readJson(req, BODY_LIMIT_BYTES);
        } catch (err) {
          return fail(
            /too large/.test(err.message) ? 413 : 400,
            "BAD_REQUEST",
            err.message,
          );
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return fail(400, "BAD_REQUEST", "body must be a JSON object");
        }
        const target = this.ext.resolve(body.endpoint, { allowRecovery: true });
        if (target.error)
          return fail(
            RELAY_ERROR_STATUS[target.error] || 500,
            target.error,
            target.message,
          );
        if (
          !this.exchange ||
          typeof body.id !== "string" ||
          !REQUEST_ID_RE.test(body.id) ||
          !body.decision ||
          typeof body.decision !== "object" ||
          Array.isArray(body.decision) ||
          (body.inputId !== undefined &&
            (typeof body.inputId !== "string" ||
              !REQUEST_ID_RE.test(body.inputId)))
        )
          return fail(
            400,
            "BAD_REQUEST",
            "id and a structured decision are required",
          );
        return reply(
          200,
          await this.exchange.respond(
            target.endpointId,
            body.id,
            body.decision,
            body.inputId,
          ),
        );
      }

      return fail(404, "NOT_FOUND", "not found");
    } catch (err) {
      return fail(500, "INTERNAL", err.message);
    }
  }

  close() {
    this.server.close();
  }
}

function readJson(req, limitBytes) {
  // Past the cap the body is DRAINED, not collected, and the socket is left
  // alive so the refusal can actually be written back -- destroying the request
  // mid-upload resets the connection and the caller sees a socket error instead
  // of the 413 that explains itself. A genuine flood still gets cut off.
  const hardKillBytes = limitBytes * 8;
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        if (!over) {
          over = true;
          chunks.length = 0;
          reject(new Error("body too large"));
        }
        if (size > hardKillBytes) req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export { AgentLane, BIND, BODY_LIMIT_BYTES, RELAY_ERROR_STATUS };
