import {
  previewGatewayRouteSchema,
  LOOPBACK_HOST,
  GatewayAdapterError,
  type GatewayObservedRoute,
  type GatewayPolicy, type PreviewGatewayRoute,
  type PreviewGatewayRouteIdentity
} from "./types.js";

export const CADDY_ROUTE_ID_PREFIX = "devspace-preview-v1.";
export const CADDY_FALLBACK_ROUTE_ID = "devspace-preview-fallback-v1";

export interface CaddyReverseProxyRoute {
  readonly "@id": string;
  readonly match: readonly [{ readonly host: readonly [string] }];
  readonly handle: readonly [{
    readonly handler: "reverse_proxy";
    readonly upstreams: readonly [{ readonly dial: string }];
    readonly flush_interval: -1;
  }];
  readonly terminal: true;
}

export interface CaddyFallbackRoute {
  readonly "@id": typeof CADDY_FALLBACK_ROUTE_ID;
  readonly handle: readonly [{
    readonly handler: "static_response";
    readonly status_code: 404;
    readonly body: "Not Found";
  }];
  readonly terminal: true;
}

export function toCaddyFallbackRoute(): CaddyFallbackRoute {
  return {
    "@id": CADDY_FALLBACK_ROUTE_ID,
    handle: [{ handler: "static_response", status_code: 404, body: "Not Found" }],
    terminal: true
  };
}

function isCaddyFallbackRoute(input: unknown): input is CaddyFallbackRoute {
  const record = object(input);
  if (record === null || record["@id"] !== CADDY_FALLBACK_ROUTE_ID || record.terminal !== true
    || "match" in record || !Array.isArray(record.handle) || record.handle.length !== 1) return false;
  const handler = object(record.handle[0]);
  return handler !== null && handler.handler === "static_response" && handler.status_code === 404
    && handler.body === "Not Found" && Object.keys(record).every((key) => ["@id", "handle", "terminal"].includes(key));
}

const routeDocuments = new WeakMap<object, PreviewGatewayRoute>();

function reject(message: string, stage: "validation" | "reconcile" = "validation"): never {
  throw new GatewayAdapterError(stage, message, "INVALID_ROUTE");
}

function encode(value: string): string { return Buffer.from(value, "utf8").toString("base64url"); }
function decode(value: string): string | null {
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    return decoded.length > 0 && encode(decoded) === value ? decoded : null;
  } catch { return null; }
}

export function validateGatewayRoute(input: unknown, isApprovedHostname?: (hostname: string) => boolean): PreviewGatewayRoute {
  const route = previewGatewayRouteSchema.safeParse(input);
  if (!route.success) throw new GatewayAdapterError("validation", "The gateway route is not a closed valid Agent-owned route.");
  if (isApprovedHostname !== undefined && !isApprovedHostname(route.data.hostname)) {
    throw new GatewayAdapterError("validation", "The gateway hostname is outside the approved preview registry.");
  }
  return route.data;
}

function validator(policyOrValidator?: GatewayPolicy | ((hostname: string) => boolean)): ((hostname: string) => boolean) | undefined {
  if (typeof policyOrValidator === "function") return policyOrValidator;
  if (policyOrValidator === undefined) return undefined;
  return (hostname) => policyOrValidator.approvedPreviewBases.some((base) => hostname === base.domain || hostname.endsWith(`.${base.domain}`));
}

export function validateRoute(input: unknown, policy: GatewayPolicy): PreviewGatewayRoute {
  const parsed = validateGatewayRoute(input, validator(policy));
  const base = policy.approvedPreviewBases.find((candidate) => candidate.id === parsed.approvedBaseId);
  if (base === undefined || !(parsed.hostname === base.domain || parsed.hostname.endsWith(`.${base.domain}`))) reject("The gateway hostname is outside the approved preview registry.");
  return parsed;
}

export function routeResourceKey(input: PreviewGatewayRouteIdentity): string {
  return [input.projectId, input.workspaceId, input.previewId, input.revisionId, input.generation].join("\u001f");
}
export function routeIdentityKey(input: PreviewGatewayRouteIdentity): string {
  return `${routeResourceKey(input)}\u001f${input.hostname}`;
}
export function sameRouteIdentity(left: PreviewGatewayRouteIdentity, right: PreviewGatewayRouteIdentity): boolean {
  return routeIdentityKey(left) === routeIdentityKey(right);
}

export function routeId(input: PreviewGatewayRoute): string {
  return `${CADDY_ROUTE_ID_PREFIX}${[
    input.projectId, input.workspaceId, input.previewId, input.revisionId, input.approvedBaseId, input.leaseId
  ].map(encode).join(".")}.g${input.generation}.ws${input.webSocketForwarding ? "1" : "0"}`;
}

interface ParsedRouteId {
  projectId: string; workspaceId: string; previewId: string; revisionId: string; approvedBaseId: string; leaseId: string;
  generation: number; webSocketForwarding: boolean;
}

function parseRouteId(input: string): ParsedRouteId | null {
  if (!input.startsWith(CADDY_ROUTE_ID_PREFIX)) return null;
  const parts = input.slice(CADDY_ROUTE_ID_PREFIX.length).split(".");
  if (parts.length !== 8 || !parts[6]?.startsWith("g") || !parts[7]?.startsWith("ws")) return null;
  const decoded = parts.slice(0, 6).map(decode);
  if (decoded.some((candidate) => candidate === null)) return null;
  const generationText = parts[6].slice(1);
  const websocketText = parts[7].slice(2);
  const generation = Number(generationText);
  if (!/^[1-9][0-9]*$/u.test(generationText) || !Number.isSafeInteger(generation)
    || !/^[01]$/u.test(websocketText)) return null;
  return {
    projectId: decoded[0]!, workspaceId: decoded[1]!, previewId: decoded[2]!, revisionId: decoded[3]!, approvedBaseId: decoded[4]!, leaseId: decoded[5]!,
    generation, webSocketForwarding: websocketText === "1"
  };
}

export function toCaddyRoute(input: PreviewGatewayRoute, isApprovedHostname?: ((hostname: string) => boolean) | GatewayPolicy): CaddyReverseProxyRoute {
  const route = typeof isApprovedHostname === "object"
    ? validateRoute(input, isApprovedHostname)
    : validateGatewayRoute(input, validator(isApprovedHostname));
  const document: CaddyReverseProxyRoute = {
    "@id": routeId(route),
    match: [{ host: [route.hostname] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${LOOPBACK_HOST}:${route.hostPort}` }], flush_interval: -1 }],
    terminal: true
  };
  routeDocuments.set(document, route);
  return document;
}

export const toCaddyRouteDocument = toCaddyRoute;

export function toCaddyRouteSet(
  inputs: readonly PreviewGatewayRoute[],
  isApprovedHostname?: ((hostname: string) => boolean) | GatewayPolicy
): readonly (CaddyReverseProxyRoute | CaddyFallbackRoute)[] {
  return [...validateRouteSet(inputs, isApprovedHostname).map((route) => toCaddyRoute(route, isApprovedHostname)), toCaddyFallbackRoute()];
}

function object(input: unknown): Record<string, unknown> | null {
  return input !== null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : null;
}

function hostnames(input: Record<string, unknown>): string[] {
  if (!Array.isArray(input.match)) return [];
  return input.match.flatMap((matcher) => {
    const candidate = object(matcher);
    return candidate !== null && Array.isArray(candidate.host) ? candidate.host.filter((value): value is string => typeof value === "string") : [];
  });
}

function parseManagedRoute(input: Record<string, unknown>, id: string, isApprovedHostname?: ((hostname: string) => boolean) | GatewayPolicy): PreviewGatewayRoute | null {
  const parsedId = parseRouteId(id);
  if (parsedId === null || !Array.isArray(input.match) || input.match.length !== 1 || !Array.isArray(input.handle)
    || input.handle.length !== 1 || input.terminal !== true) return null;
  const matcher = object(input.match[0]);
  const handler = object(input.handle[0]);
  if (matcher === null || handler === null || !Array.isArray(matcher.host) || matcher.host.length !== 1
    || typeof matcher.host[0] !== "string" || handler.handler !== "reverse_proxy" || !Array.isArray(handler.upstreams)
    || handler.upstreams.length !== 1 || handler.flush_interval !== -1) return null;
  const upstream = object(handler.upstreams[0]);
  if (upstream === null || typeof upstream.dial !== "string") return null;
  const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(upstream.dial);
  if (match === null) return null;
  try {
    const candidate = { ...parsedId, hostname: matcher.host[0], hostIp: LOOPBACK_HOST, hostPort: Number(match[1]) };
    return typeof isApprovedHostname === "object" ? validateRoute(candidate, isApprovedHostname) : validateGatewayRoute(candidate, isApprovedHostname);
  } catch { return null; }
}

export function fromCaddyRoutes(body: unknown, isApprovedHostname?: ((hostname: string) => boolean) | GatewayPolicy): readonly GatewayObservedRoute[] {
  if (!Array.isArray(body)) throw new GatewayAdapterError("admin", "Caddy returned an invalid route set.", "ADMIN_REJECTED");
  return body.flatMap((candidate) => {
    if (isCaddyFallbackRoute(candidate)) return [];
    const record = object(candidate);
    if (record === null) return { kind: "foreign", routeId: null, hostnames: [] } as const;
    const id = typeof record["@id"] === "string" ? record["@id"] : null;
    if (id !== null && id.startsWith(CADDY_ROUTE_ID_PREFIX)) {
      const route = parseManagedRoute(record, id, isApprovedHostname);
      if (route !== null) return { kind: "managed", route } as const;
    }
    return { kind: "foreign", routeId: id, hostnames: hostnames(record) } as const;
  });
}

export function parseCaddyRouteDocument(input: unknown, policy?: GatewayPolicy): GatewayObservedRoute {
  if (typeof input === "object" && input !== null) {
    const retained = routeDocuments.get(input);
    if (retained !== undefined) return { kind: "managed", route: policy === undefined ? retained : validateRoute(retained, policy) };
  }
  return fromCaddyRoutes([input], validator(policy))[0] ?? { kind: "foreign", routeId: null, hostnames: [] };
}

export function routeMatches(input: PreviewGatewayRoute, candidate: unknown, isApprovedHostname?: ((hostname: string) => boolean) | GatewayPolicy): boolean {
  const parsed = object(candidate);
  if (parsed === null) return false;
  const id = typeof parsed["@id"] === "string" ? parsed["@id"] : null;
  const route = id === null ? null : parseManagedRoute(parsed, id, isApprovedHostname);
  return route !== null && sameRouteIdentity(route, input) && route.leaseId === input.leaseId
    && route.hostPort === input.hostPort && route.webSocketForwarding === input.webSocketForwarding;
}

export function validateRouteSet(inputs: readonly PreviewGatewayRoute[], isApprovedHostname?: ((hostname: string) => boolean) | GatewayPolicy): PreviewGatewayRoute[] {
  if (!Array.isArray(inputs) || inputs.length > 256) reject("The desired route set is outside the bounded policy.", "reconcile");
  const routes = inputs.map((input) => typeof isApprovedHostname === "object"
    ? validateRoute(input, isApprovedHostname)
    : validateGatewayRoute(input, isApprovedHostname));
  const keys = new Set<string>(); const hosts = new Set<string>();
  for (const route of routes) {
    if (keys.has(routeIdentityKey(route)) || hosts.has(route.hostname)) reject("The desired route set contains duplicate identity or hostname.", "reconcile");
    keys.add(routeIdentityKey(route)); hosts.add(route.hostname);
  }
  return routes;
}
