// Owned test processes only. This is a Node TCP/fetch guard, NOT an OS sandbox.
import net from "node:net";
import { appendFileSync } from "node:fs";
const allowed = new Set(["127.0.0.1", "::1", "localhost"]);
function deny(host) {
  if (allowed.has(host)) return;
  if (process.env.PI099_NETWORK_LOG)
    appendFileSync(process.env.PI099_NETWORK_LOG, JSON.stringify({ blockedHost: host }) + "\n");
  throw new Error(`PI099 test blocked non-loopback host: ${host}`);
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first && typeof first === "object") {
    if (first.path) throw new Error("PI099 test refuses Unix socket connections");
    deny(first.host ?? first.hostname ?? "localhost");
  } else if (typeof first === "number") {
    deny(typeof args[1] === "string" ? args[1] : "localhost");
  } else {
    throw new Error("PI099 test refuses unknown socket address shape");
  }
  return originalConnect.apply(this, args);
};
const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  deny(url.hostname);
  return originalFetch.call(this, input, init);
};
