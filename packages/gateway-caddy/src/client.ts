import http from "node:http";
import { unlink } from "node:fs/promises";
import { validateGatewayRoute, validateRoute, fromCaddyRoutes, routeIdentityKey, routeResourceKey, routeMatches, toCaddyRoute, validateRouteSet } from "./routes.js";
import {
  GatewayAdapterError, previewGatewayProbeRequestSchema, previewGatewayProbeResultSchema, previewGatewayRouteIdentitySchema,
  type CaddyAdminResponse, type CaddyAdminTransport,
  type CaddyGatewayClientOptions, type GatewayObservedRoute,
  type GatewayPolicy, type PreviewGatewayLease,
  type GatewayHostProbeContract,
  type GatewayRouteInspection, type PreviewGatewayAdapterContract,
  type PreviewGatewayProbeRequest, type PreviewGatewayProbeResult, type PreviewGatewayRoute,
  type PreviewGatewayRouteIdentity
} from "./types.js";

const routesPath = "/config/apps/http/servers/devspace-preview/routes";
const maxAdminBodyBytes = 1_048_576;

function isFullRoute(input: PreviewGatewayRoute | PreviewGatewayRouteIdentity): input is PreviewGatewayRoute {
  return "leaseId" in input;
}

function validateIdentity(input: PreviewGatewayRouteIdentity): PreviewGatewayRouteIdentity {
  const parsed = previewGatewayRouteIdentitySchema.safeParse(input);
  if (!parsed.success) throw new GatewayAdapterError("validation", "The gateway route identity is not closed and valid.");
  return parsed.data;
}

export class PrivateCaddyAdminTransport implements CaddyAdminTransport {
  constructor(private readonly options: { readonly socketPath: string; readonly timeoutMs?: number }) {
    if (options.socketPath.trim() === "") throw new GatewayAdapterError("validation", "A private Caddy admin Unix socket is required.");
  }
  async request(method: "GET" | "PUT", path: string, body?: readonly unknown[], timeoutMs = this.options.timeoutMs ?? 5_000): Promise<CaddyAdminResponse> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise((resolve, reject) => {
      const request = http.request({ socketPath: this.options.socketPath, path, method, headers: {
        accept: "application/json", ...(encoded === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) })
      }}, (response) => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => { size += chunk.length; if (size <= maxAdminBodyBytes) chunks.push(chunk); });
        response.on("end", () => {
          if (size > maxAdminBodyBytes) return reject(new GatewayAdapterError("admin", "Caddy admin response exceeded the bounded size.", "ADMIN_REJECTED"));
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          if (text !== "") { try { parsed = JSON.parse(text); } catch { parsed = text; } }
          resolve({ statusCode: response.statusCode ?? 0, body: parsed });
        });
      });
      request.setTimeout(timeoutMs, () => request.destroy(new GatewayAdapterError("admin", "Caddy admin request timed out.", "ADMIN_UNAVAILABLE", true)));
      request.on("error", (error) => reject(error instanceof GatewayAdapterError ? error : new GatewayAdapterError("admin", "Caddy admin is unavailable.", "ADMIN_UNAVAILABLE", true)));
      if (encoded !== undefined) request.write(encoded);
      request.end();
    });
  }
}

function ensureStatus(response: CaddyAdminResponse): void {
  if (![200, 201, 204].includes(response.statusCode)) {
    throw new GatewayAdapterError("admin", `Caddy admin returned HTTP ${response.statusCode}.`, response.statusCode >= 500 ? "ADMIN_UNAVAILABLE" : "ADMIN_REJECTED", response.statusCode >= 500);
  }
}

export class CaddyGatewayClient implements PreviewGatewayAdapterContract {
  private readonly leases = new Map<string, PreviewGatewayRoute>();
  private readonly options: CaddyGatewayClientOptions;
  constructor(private readonly transport: CaddyAdminTransport, options: CaddyGatewayClientOptions | GatewayPolicy = {}) {
    this.options = "approvedPreviewBases" in options
      ? { policy: options, isApprovedHostname: (hostname) => options.approvedPreviewBases.some((base) => hostname === base.domain || hostname.endsWith(`.${base.domain}`)) }
      : options;
  }

  private validate(input: PreviewGatewayRoute): PreviewGatewayRoute {
    return this.options.policy === undefined ? validateGatewayRoute(input, this.options.isApprovedHostname) : validateRoute(input, this.options.policy);
  }
  private async readRoutes(): Promise<readonly GatewayObservedRoute[]> {
    if (this.transport.listRoutes !== undefined) return await this.transport.listRoutes();
    if (this.transport.request === undefined) throw new GatewayAdapterError("admin", "Caddy admin is unavailable.", "ADMIN_UNAVAILABLE", true);
    let response: CaddyAdminResponse;
    try { response = await this.transport.request("GET", routesPath, undefined, this.options.timeoutMs); }
    catch (error) { if (error instanceof GatewayAdapterError) throw error; throw new GatewayAdapterError("admin", "Caddy admin is unavailable.", "ADMIN_UNAVAILABLE", true); }
    ensureStatus(response);
    return fromCaddyRoutes(response.body, this.options.policy ?? this.options.isApprovedHostname);
  }
  private async replaceRoutes(routes: readonly PreviewGatewayRoute[]): Promise<void> {
    if (this.transport.replaceRoutes !== undefined) return await this.transport.replaceRoutes(routes);
    if (this.transport.request === undefined) throw new GatewayAdapterError("admin", "Caddy admin is unavailable.", "ADMIN_UNAVAILABLE", true);
    let response: CaddyAdminResponse;
    try {
      response = await this.transport.request("PUT", routesPath,
        routes.map((route) => toCaddyRoute(route, this.options.policy ?? this.options.isApprovedHostname)), this.options.timeoutMs);
    } catch (error) { if (error instanceof GatewayAdapterError) throw error; throw new GatewayAdapterError("admin", "Caddy admin is unavailable.", "ADMIN_UNAVAILABLE", true); }
    ensureStatus(response);
  }
  private currentManaged(current: readonly GatewayObservedRoute[]): PreviewGatewayRoute[] {
    return current.filter((candidate): candidate is Extract<GatewayObservedRoute, { kind: "managed" }> => candidate.kind === "managed")
      .map((candidate) => candidate.route);
  }
  async ensureRoute(input: PreviewGatewayRoute): Promise<void> {
    const route = this.validate(input);
    const current = this.currentManaged(await this.readRoutes());
    const desired = current.filter((candidate) => candidate.hostname !== route.hostname && routeResourceKey(candidate) !== routeResourceKey(route));
    this.leases.set(route.leaseId, route);
    desired.push(route);
    await this.replaceRoutes(desired);
  }
  async replaceRoute(input: PreviewGatewayRoute): Promise<void> { await this.ensureRoute(input); }
  async removeRoute(input: PreviewGatewayRoute | PreviewGatewayRouteIdentity): Promise<void> {
    const identity = isFullRoute(input) ? this.validate(input) : validateIdentity(input);
    const current = this.currentManaged(await this.readRoutes());
    const desired = current.filter((candidate) => candidate.hostname !== identity.hostname && routeResourceKey(candidate) !== routeResourceKey(identity));
    if (isFullRoute(identity)) this.leases.delete(identity.leaseId);
    await this.replaceRoutes(desired);
  }
  async inspectRoute(input: PreviewGatewayRoute | PreviewGatewayRouteIdentity): Promise<GatewayRouteInspection> {
    const expected = isFullRoute(input) ? this.validate(input) : validateIdentity(input);
    const current = await this.readRoutes();
    const managed = this.currentManaged(current);
    const exact = managed.find((candidate) => isFullRoute(expected)
      ? routeMatches(expected, toCaddyRoute(candidate, this.options.policy ?? this.options.isApprovedHostname), this.options.policy ?? this.options.isApprovedHostname)
      : routeIdentityKey(candidate) === routeIdentityKey(expected));
    if (exact !== undefined) {
      const exactMatch = isFullRoute(expected) ? exact.leaseId === expected.leaseId && exact.hostPort === expected.hostPort
        && exact.webSocketForwarding === expected.webSocketForwarding : true;
      return exactMatch ? { present: true, status: "present", route: exact } : { present: false, status: "stale", route: exact, reason: "route-does-not-match-exact-lease" };
    }
    const stale = managed.find((candidate) => routeResourceKey(candidate) === routeResourceKey(expected)
      && candidate.hostname === expected.hostname);
    if (stale !== undefined) return { present: false, status: "stale", route: stale, reason: "route-does-not-match-exact-lease" };
    if (current.some((candidate) => candidate.kind === "foreign" && candidate.hostnames.includes(expected.hostname))) {
      return { present: false, status: "foreign", reason: "a foreign route owns the approved hostname" };
    }
    return { present: false, status: "absent" };
  }
  async reconcileRoutes(inputs: readonly PreviewGatewayRoute[]): Promise<void> {
    const routes = validateRouteSet(inputs, this.options.policy ?? this.options.isApprovedHostname);
    await this.replaceRoutes(routes);
    this.leases.clear();
    for (const route of routes) this.leases.set(route.leaseId, route);
  }
  async probe(input: PreviewGatewayProbeRequest): Promise<PreviewGatewayProbeResult> {
    const { signal: _signal, ...wireInput } = input;
    const parsed = previewGatewayProbeRequestSchema.safeParse(wireInput);
    if (!parsed.success) return { kind: "infrastructure", message: "The gateway probe request is invalid." };
    if (this.options.probe === undefined) return { kind: "infrastructure", message: "The private gateway-host probe is unavailable." };
    return await this.options.probe.probe(input);
  }
}

/** Stable concrete Agent integration API. */
export class PreviewGatewayAdapter extends CaddyGatewayClient {
  constructor(options: { readonly transport: CaddyAdminTransport; readonly policy: GatewayPolicy; readonly probe: GatewayHostProbeContract }) {
    super(options.transport, { policy: options.policy, isApprovedHostname: (hostname) => options.policy.approvedPreviewBases.some((base) => hostname === base.domain || hostname.endsWith(`.${base.domain}`)),
      probe: options.probe });
  }
}
export const CaddyGatewayAdapter = PreviewGatewayAdapter;

export class GatewayHostProbe {
  constructor(private readonly resolveLease: (leaseId: string) => Promise<PreviewGatewayLease | null>) {}
  async probe(input: PreviewGatewayProbeRequest): Promise<PreviewGatewayProbeResult> {
    const { signal: _signal, ...wireInput } = input;
    const parsed = previewGatewayProbeRequestSchema.safeParse(wireInput);
    if (!parsed.success) return { kind: "infrastructure", message: "The gateway probe request is invalid." };
    const lease = await this.resolveLease(parsed.data.leaseId).catch(() => null);
    if (lease === null || lease.hostIp !== "127.0.0.1") return { kind: "infrastructure", message: "The opaque preview lease is unavailable." };
    return await probeLoopback(lease.hostPort, parsed.data.path, parsed.data.deadlineMs, input.signal);
  }
}

/**
 * Agent-side client for a deployment-provided host gateway probe service.
 * The socket peer resolves the lease; this client never receives or sends a
 * host, address, port, URL, or Caddy document as part of health probing.
 */
export class PrivateGatewayProbeTransport implements GatewayHostProbeContract {
  constructor(private readonly options: { readonly socketPath: string; readonly timeoutMs?: number }) {
    if (options.socketPath.trim() === "") throw new GatewayAdapterError("validation", "A private gateway probe Unix socket is required.");
  }

  async probe(input: PreviewGatewayProbeRequest): Promise<PreviewGatewayProbeResult> {
    const { signal, ...wireInput } = input;
    const parsed = previewGatewayProbeRequestSchema.safeParse(wireInput);
    if (!parsed.success) return { kind: "infrastructure", message: "The gateway probe request is invalid." };
    const encoded = JSON.stringify(parsed.data);
    const timeoutMs = Math.min(this.options.timeoutMs ?? parsed.data.deadlineMs + 1_000, 121_000);
    return await new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (result: PreviewGatewayProbeResult) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(result);
      };
      const request = http.request({ socketPath: this.options.socketPath, method: "POST", path: "/v1/preview/probe",
        signal, headers: { accept: "application/json", "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } }, (response) => {
        const chunks: Buffer[] = []; let bytes = 0;
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes <= 16_384) chunks.push(chunk); });
        response.on("end", () => {
          if (bytes > 16_384 || response.statusCode !== 200) { finish({ kind: "infrastructure", message: "The private gateway probe is unavailable." }); return; }
          try {
            const result = previewGatewayProbeResultSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            finish(result);
          } catch { finish({ kind: "infrastructure", message: "The private gateway probe returned an invalid result." }); }
        });
      });
      request.setTimeout(timeoutMs, () => { request.destroy(); finish({ kind: "timeout" }); });
      request.once("error", () => finish(signal.aborted ? { kind: "timeout" } : { kind: "infrastructure", message: "The private gateway probe is unavailable." }));
      timer = setTimeout(() => { request.destroy(); finish({ kind: "timeout" }); }, timeoutMs);
      request.end(encoded);
    });
  }
}

/** Host-side private probe service used by direct development and deployment adapters. */
export class GatewayHostProbeServer {
  private readonly server: http.Server;
  private started = false;
  constructor(private readonly options: {
    readonly socketPath: string;
    readonly resolveLease: (leaseId: string) => Promise<PreviewGatewayLease | null>;
  }) {
    if (options.socketPath.trim() === "") throw new GatewayAdapterError("validation", "A private gateway probe Unix socket is required.");
    const hostProbe = new GatewayHostProbe(options.resolveLease);
    this.server = http.createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/preview/probe") { response.writeHead(404).end(); return; }
      try {
        const chunks: Buffer[] = []; let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.from(chunk); bytes += buffer.length;
          if (bytes > 16_384) throw new Error("probe-body-too-large");
          chunks.push(buffer);
        }
        const parsed = previewGatewayProbeRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), parsed.deadlineMs); timer.unref();
        request.once("aborted", () => controller.abort());
        const result = await hostProbe.probe({ ...parsed, signal: controller.signal });
        clearTimeout(timer);
        const encoded = JSON.stringify(result);
        response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }).end(encoded);
      } catch {
        if (!response.headersSent) response.writeHead(400).end();
      }
    });
  }
  async start(): Promise<void> {
    await unlink(this.options.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.options.socketPath, resolve); });
    this.started = true;
  }
  async stop(): Promise<void> {
    if (this.started) await new Promise<void>((resolve, reject) => this.server.close((error) => error === undefined ? resolve() : reject(error)));
    await unlink(this.options.socketPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    this.started = false;
  }
}

export class CaddyAdminHttpTransport implements CaddyAdminTransport {
  private readonly adminUrl: URL;
  constructor(options: { readonly adminUrl: string; readonly fetch?: typeof fetch }, private readonly policy: GatewayPolicy) {
    this.adminUrl = new URL(options.adminUrl);
    if (this.adminUrl.protocol !== "http:" || this.adminUrl.hostname !== "127.0.0.1") {
      throw new GatewayAdapterError("validation", "Caddy admin must use the private loopback origin.", "INVALID_ROUTE");
    }
    this.fetcher = options.fetch ?? fetch;
  }
  private readonly fetcher: typeof fetch;
  async request(method: "GET" | "PUT", path: string, body?: readonly unknown[]): Promise<CaddyAdminResponse> {
    const response = await this.fetcher(new URL(path, this.adminUrl), {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    });
    let parsed: unknown = null;
    if (response.status !== 204) { try { parsed = await response.json(); } catch { parsed = null; } }
    return { statusCode: response.status, body: parsed };
  }
  async listRoutes(): Promise<readonly GatewayObservedRoute[]> {
    const response = await this.request("GET", routesPath);
    if (response.statusCode !== 200) throw new GatewayAdapterError("admin", "Caddy admin is unavailable.", "ADMIN_UNAVAILABLE", true);
    return fromCaddyRoutes(response.body, this.policy);
  }
  async replaceRoutes(routes: readonly PreviewGatewayRoute[]): Promise<void> {
    const response = await this.request("PUT", routesPath, routes.map((route) => toCaddyRoute(route, this.policy)));
    if (![200, 204].includes(response.statusCode)) throw new GatewayAdapterError("admin", "Caddy admin rejected the route set.", "ADMIN_REJECTED");
  }
  private get optionsForPolicy(): (hostname: string) => boolean {
    return (hostname) => this.policy.approvedPreviewBases.some((base) => hostname === base.domain || hostname.endsWith(`.${base.domain}`));
  }
}

async function probeLoopback(hostPort: number, path: string, deadlineMs: number, signal: AbortSignal): Promise<PreviewGatewayProbeResult> {
  return await new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: PreviewGatewayProbeResult) => { if (settled) return; settled = true; if (timer !== undefined) clearTimeout(timer); resolve(result); };
    const request = http.request({ host: "127.0.0.1", port: hostPort, path, method: "GET", headers: { connection: "close" }, signal }, (response) => {
      response.resume(); response.once("end", () => finish({ kind: "response", statusCode: response.statusCode ?? 0 }));
    });
    timer = setTimeout(() => { request.destroy(); finish({ kind: "timeout" }); }, deadlineMs);
    request.once("error", () => finish(signal.aborted ? { kind: "timeout" } : { kind: "infrastructure", message: "The loopback preview target is unavailable." }));
    request.end();
  });
}
