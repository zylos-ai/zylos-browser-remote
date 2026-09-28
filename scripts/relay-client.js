// Private Agent-host HTTP client for decisions and status.
//
// Built as a factory so the timeout behaviour can be tested deterministically.
// Under CommonJS the test read this file's source text and ran it through
// `vm.runInNewContext` with a fake `require`/`module`/`setTimeout` injected;
// ESM source cannot be executed that way. Injecting the same seams as plain
// arguments is both simpler and stronger -- the test now exercises the module
// that actually ships rather than a re-evaluated copy of its text.
import http from "http";

function defaultBase() {
  return (
    process.env.BROWSER_REMOTE_AGENT_URL ||
    `http://127.0.0.1:${process.env.BROWSER_REMOTE_AGENT_PORT || 3803}`
  );
}

/**
 * @param {Object} [deps] test seams; every one defaults to the real thing
 * @param {Object} [deps.http] node:http, or a stub exposing `request`
 * @param {string} [deps.base] agent lane origin
 * @param {Function} [deps.setTimeout]
 * @param {Function} [deps.clearTimeout]
 * @returns {{BASE: string, status: Function, decision: Function}}
 */
function createClient(deps = {}) {
  const {
    http: httpImpl = http,
    base = defaultBase(),
    setTimeout: setTimer = setTimeout,
    clearTimeout: clearTimer = clearTimeout,
  } = deps;

  function call(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(pathname, base);
      if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
        reject(new Error(`refusing non-loopback agent lane ${url.host}`));
        return;
      }
      const data = body === undefined ? null : JSON.stringify(body);
      const timeoutMs = pathname === "/decision" ? 125000 : 10000;
      let timer;
      const req = httpImpl.request(
        {
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          method,
          headers: data
            ? {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              }
            : {},
        },
        (res) => {
          let b = "";
          res.on("data", (c) => (b += c));
          res.on("end", () => {
            clearTimer(timer);
            let parsed;
            try {
              parsed = JSON.parse(b);
            } catch {
              parsed = {
                ok: false,
                code: "BAD_RESPONSE",
                message: b.slice(0, 200),
              };
            }
            resolve({ status: res.statusCode, body: parsed });
          });
          res.on("error", (err) => {
            clearTimer(timer);
            reject(err);
          });
        },
      );
      req.on("error", (err) => {
        clearTimer(timer);
        if (err.code === "ECONNREFUSED") {
          resolve({
            status: 0,
            body: {
              ok: false,
              code: "RELAY_DOWN",
              message: `relay not listening at ${base} (pm2 status zylos-browser-remote)`,
            },
          });
        } else {
          reject(err);
        }
      });
      timer = setTimer(() => {
        req.destroy(
          Object.assign(
            new Error(
              `Relay HTTP response timed out after ${timeoutMs}ms; delivery is unknown, do not automatically resend`,
            ),
            { code: "RELAY_RESPONSE_TIMEOUT" },
          ),
        );
      }, timeoutMs);
      if (data) req.write(data);
      req.end();
    });
  }

  return {
    BASE: base,
    status: () => call("GET", "/status"),
    decision: (body) => call("POST", "/decision", body),
  };
}

// The singleton the CLI clients in scripts/ import; unchanged in behaviour.
const client = createClient();

export { createClient };
export default client;
