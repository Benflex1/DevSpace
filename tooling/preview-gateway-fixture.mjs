import http from "node:http";
import net from "node:net";

const LOOPBACK_HOST = "127.0.0.1";
const defaultBases = [{ id: "local", domain: "localhost" }];
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const dnsLabelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function fail(message) {
  throw new Error(message);
}

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name}-must-be-object`);
  return value;
}

function identity(value, name) {
  if (typeof value !== "string" || !identifierPattern.test(value)) fail(`${name}-invalid`);
  return value;
}

function port(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) fail(`${name}-invalid`);
  return value;
}

function normalizeBases(input) {
  if (!Array.isArray(input) || input.length === 0) fail("preview-base-registry-invalid");
  const bases = input.map((candidate) => {
    const entry = object(candidate, "preview-base");
    const id = identity(entry.id, "preview-base-id");
    const domain = entry.domain;
    if (typeof domain !== "string" || domain.length === 0 || domain !== domain.toLowerCase() || domain.endsWith(".")
      || domain.split(".").some((label) => !dnsLabelPattern.test(label))) fail("preview-base-domain-invalid");
    return { id, domain };
  });
  if (new Set(bases.map((base) => base.id)).size !== bases.length) fail("preview-base-id-duplicate");
  return bases;
}

function normalizeRoute(input, bases) {
  const candidate = object(input, "preview-route");
  const route = {
    projectId: identity(candidate.projectId, "project-id"),
    workspaceId: identity(candidate.workspaceId, "workspace-id"),
    previewId: identity(candidate.previewId, "preview-id"),
    revisionId: identity(candidate.revisionId, "revision-id"),
    generation: port(candidate.generation, "generation"),
    hostname: candidate.hostname,
    approvedBaseId: identity(candidate.approvedBaseId, "approved-base-id"),
    leaseId: identity(candidate.leaseId, "lease-id"),
    hostIp: candidate.hostIp,
    hostPort: candidate.hostPort,
    webSocketForwarding: candidate.webSocketForwarding
  };
  if (typeof route.hostname !== "string" || route.hostname.length > 253 || route.hostname !== route.hostname.toLowerCase()
    || route.hostname.endsWith(".") || route.hostname.split(".").some((label) => !dnsLabelPattern.test(label))) fail("hostname-invalid");
  const base = bases.find((candidateBase) => candidateBase.id === route.approvedBaseId);
  if (base === undefined || (route.hostname !== base.domain && !route.hostname.endsWith(`.${base.domain}`))) fail("hostname-not-approved");
  if (route.hostIp !== LOOPBACK_HOST) fail("lease-not-loopback");
  const lease = { leaseId: route.leaseId, hostIp: LOOPBACK_HOST, hostPort: port(route.hostPort, "lease-port") };
  if (typeof route.webSocketForwarding !== "boolean") fail("websocket-policy-invalid");
  return Object.freeze({ ...route, ...lease });
}

function identityKey(route) {
  return [route.projectId, route.workspaceId, route.previewId, route.revisionId, route.generation].join("\u001f");
}

function sameRoute(left, right) {
  return identityKey(left) === identityKey(right)
    && left.hostname === right.hostname && left.approvedBaseId === right.approvedBaseId
    && left.leaseId === right.leaseId && left.hostIp === right.hostIp
    && left.hostPort === right.hostPort && left.webSocketForwarding === right.webSocketForwarding;
}

function hostFromRequest(request) {
  const value = request.headers.host;
  if (typeof value !== "string") return null;
  if (value.startsWith("[")) return null;
  const separator = value.lastIndexOf(":");
  return separator > -1 && value.indexOf(":") === separator ? value.slice(0, separator).toLowerCase() : value.toLowerCase();
}

function requestPath(request) {
  const value = request.url ?? "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\u0000")) return null;
  return value;
}

function writeUpgradeError(socket, status = 404, message = "Not Found") {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function createPreviewGatewayFixture(options = {}) {
  const bases = normalizeBases(options.approvedPreviewBases ?? defaultBases);
  const routes = new Map();
  const leases = new Map();
  const sockets = new Set();
  const upstreamSockets = new Set();

  function routeForRequest(request) {
    const host = hostFromRequest(request);
    return host === null ? null : routes.get(host) ?? null;
  }

  const server = http.createServer((request, response) => {
    const route = routeForRequest(request);
    const path = requestPath(request);
    if (route === null || path === null) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }
    const upstream = http.request({
      host: LOOPBACK_HOST,
      port: route.hostPort,
      method: request.method,
      path,
      headers: { ...request.headers, host: route.hostname }
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("Bad Gateway");
    });
    request.pipe(upstream);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const route = routeForRequest(request);
    const path = requestPath(request);
    if (route === null || path === null) { writeUpgradeError(socket); return; }
    if (!route.webSocketForwarding) { writeUpgradeError(socket, 426, "Upgrade Required"); return; }
    const upstream = net.connect(route.hostPort, LOOPBACK_HOST, () => {
      upstreamSockets.add(upstream);
      upstream.once("close", () => upstreamSockets.delete(upstream));
      const headers = Object.entries(request.headers)
        .filter(([name]) => name.toLowerCase() !== "host")
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value ?? ""}`);
      headers.push(`Host: ${route.hostname}`);
      upstream.write(`${request.method} ${path} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? LOOPBACK_HOST, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") fail("gateway-fixture-address-unavailable");

  const fixture = {
    address: () => ({ host: address.address, port: address.port }),
    registerLease(leaseInput) {
      const candidate = object(leaseInput, "lease");
      const leaseId = identity(candidate.leaseId, "lease-id");
      leases.set(leaseId, { leaseId, hostIp: LOOPBACK_HOST, hostPort: port(candidate.hostPort, "lease-port") });
    },
    ensureRoute(input) {
      const route = normalizeRoute(input, bases);
      for (const [hostname, current] of routes) if (identityKey(current) === identityKey(route)) routes.delete(hostname);
      routes.set(route.hostname, route);
      return route;
    },
    replaceRoute(input) { return this.ensureRoute(input); },
    inspectRoute(input) {
      const current = [...routes.values()].find((candidate) => identityKey(candidate) === identityKey(input));
      if (current === undefined) return { status: "absent" };
      if ("hostname" in input && !sameRoute(current, normalizeRoute(input, bases))) {
        return { status: "stale", route: current, reason: "route-does-not-match-exact-lease-or-host" };
      }
      return { status: "present", route: current };
    },
    removeRoute(input) {
      let removed = 0;
      for (const [hostname, current] of routes) {
        if (identityKey(current) === identityKey(input)) { routes.delete(hostname); removed += 1; }
      }
      return { changed: removed > 0, desiredRouteCount: routes.size, removedManagedRouteCount: removed, removedForeignRouteCount: 0 };
    },
    reconcileRoutes(inputs) {
      const desired = inputs.map((input) => normalizeRoute(input, bases));
      if (new Set(desired.map(identityKey)).size !== desired.length || new Set(desired.map((route) => route.hostname)).size !== desired.length) {
        fail("route-set-duplicate");
      }
      const previous = [...routes.values()];
      routes.clear();
      for (const route of desired) routes.set(route.hostname, route);
      const previousKeys = new Set(previous.map(identityKey));
      const desiredKeys = new Set(desired.map(identityKey));
      return {
        changed: previous.length !== desired.length || previous.some((route) => !desiredKeys.has(identityKey(route)) || !sameRoute(route, desired.find((candidate) => identityKey(candidate) === identityKey(route)))),
        desiredRouteCount: desired.length,
        removedManagedRouteCount: previous.filter((route) => !desiredKeys.has(identityKey(route))).length,
        removedForeignRouteCount: 0
      };
    },
    routes: () => [...routes.values()],
    async probe(input) {
      const lease = leases.get(input.leaseId);
      if (lease === undefined || lease.hostIp !== LOOPBACK_HOST) return { kind: "infrastructure", message: "The opaque preview lease is unavailable." };
      if (!Number.isSafeInteger(input.deadlineMs) || input.deadlineMs < 1 || input.deadlineMs > 30_000
        || typeof input.path !== "string" || !input.path.startsWith("/")) return { kind: "infrastructure", message: "The probe request is invalid." };
      return await new Promise((resolve) => {
        let settled = false;
        const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
        const request = http.request({ host: LOOPBACK_HOST, port: lease.hostPort, method: "GET", path: input.path, signal: input.signal }, (response) => {
          response.resume();
          response.once("end", () => { clearTimeout(timer); finish({ kind: "response", statusCode: response.statusCode ?? 0 }); });
        });
        const timer = setTimeout(() => { request.destroy(); finish({ kind: "timeout" }); }, input.deadlineMs);
        request.once("error", (error) => {
          clearTimeout(timer);
          if (input.signal?.aborted) finish({ kind: "timeout" });
          else finish({ kind: "infrastructure", message: String(error.message ?? "probe-failed").slice(0, 256) });
        });
        request.end();
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      for (const socket of upstreamSockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    }
  };
  return fixture;
}
