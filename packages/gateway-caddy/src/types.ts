import * as z from "zod";

const uuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const hostnameSchema = z.string().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u);

export const previewGatewayRouteSchema = z.strictObject({
  projectId: uuidSchema,
  workspaceId: uuidSchema,
  previewId: uuidSchema,
  revisionId: uuidSchema,
  generation: z.number().int().positive(),
  hostname: hostnameSchema,
  approvedBaseId: z.string().min(1).max(64).default("unknown"),
  leaseId: uuidSchema,
  hostIp: z.literal("127.0.0.1"),
  hostPort: z.number().int().min(1).max(65535),
  webSocketForwarding: z.boolean()
});
export type PreviewGatewayRoute = z.infer<typeof previewGatewayRouteSchema>;
export type PreviewRoute = PreviewGatewayRoute;
export type PreviewRouteInput = PreviewGatewayRoute;

export const LOOPBACK_HOST = "127.0.0.1" as const;
export interface GatewayPolicy { readonly approvedPreviewBases: readonly { readonly id: string; readonly domain: string }[]; }

/** Exact resource identity; lease and generation fencing are validated on full routes. */
export const previewGatewayRouteIdentitySchema = z.strictObject({
  projectId: uuidSchema,
  workspaceId: uuidSchema,
  previewId: uuidSchema,
  revisionId: uuidSchema,
  generation: z.number().int().positive(),
  hostname: hostnameSchema
});
export type PreviewGatewayRouteIdentity = z.infer<typeof previewGatewayRouteIdentitySchema>;
export type PreviewRouteIdentity = PreviewGatewayRouteIdentity;

export const previewGatewayProbeRequestSchema = z.strictObject({
  leaseId: uuidSchema,
  path: z.string().regex(/^\//u).max(2048),
  acceptedStatuses: z.array(z.number().int().min(100).max(599)).min(1).max(32),
  deadlineMs: z.number().int().positive().max(120_000),
  webSocketForwarding: z.boolean()
});
export const previewGatewayProbeResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("response"), statusCode: z.number().int().min(100).max(599) }),
  z.strictObject({ kind: z.literal("timeout") }),
  z.strictObject({ kind: z.literal("infrastructure"), message: z.string().min(1).max(256) })
]);
export interface PreviewGatewayProbeRequest {
  readonly leaseId: string;
  readonly path: string;
  readonly acceptedStatuses: readonly number[];
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly webSocketForwarding: boolean;
}
export type PreviewGatewayProbeResult =
  | { readonly kind: "response"; readonly statusCode: number }
  | { readonly kind: "timeout" }
  | { readonly kind: "infrastructure"; readonly message: string };

export interface CaddyAdminResponse {
  readonly statusCode: number;
  readonly body: unknown;
}

/** Private transport only; callers never provide raw Caddy documents. */
export interface CaddyAdminTransport {
  request?(method: "GET" | "PUT", path: string, body?: readonly unknown[], timeoutMs?: number): Promise<CaddyAdminResponse>;
  listRoutes?(): Promise<readonly GatewayObservedRoute[]>;
  replaceRoutes?(routes: readonly PreviewGatewayRoute[]): Promise<void>;
}

export interface GatewayHostProbeContract {
  probe(input: PreviewGatewayProbeRequest): Promise<PreviewGatewayProbeResult>;
}

export interface PreviewGatewayAdapterContract {
  probe(input: PreviewGatewayProbeRequest): Promise<PreviewGatewayProbeResult>;
  ensureRoute(input: PreviewGatewayRoute): Promise<void>;
  replaceRoute(input: PreviewGatewayRoute): Promise<void>;
  removeRoute(input: PreviewGatewayRoute | PreviewGatewayRouteIdentity): Promise<void>;
  inspectRoute(input: PreviewGatewayRoute | PreviewGatewayRouteIdentity): Promise<GatewayRouteInspection>;
  reconcileRoutes(inputs: readonly PreviewGatewayRoute[]): Promise<void>;
}

export interface GatewayRouteInspection {
  readonly present: boolean;
  readonly status: "present" | "absent" | "stale" | "foreign";
  readonly route?: PreviewGatewayRoute;
  readonly reason?: string;
}

export type GatewayObservedRoute =
  | { readonly kind: "managed"; readonly route: PreviewGatewayRoute }
  | { readonly kind: "foreign"; readonly routeId: string | null; readonly hostnames: readonly string[] };

export interface PreviewGatewayLease {
  readonly leaseId: string;
  readonly hostIp: "127.0.0.1";
  readonly hostPort: number;
}
export type OpaqueLeaseResolver = (leaseId: string) => Promise<PreviewGatewayLease | null>;

export interface CaddyGatewayClientOptions {
  readonly policy?: GatewayPolicy;
  readonly isApprovedHostname?: (hostname: string) => boolean;
  readonly probe?: GatewayHostProbeContract;
  readonly timeoutMs?: number;
}

export class GatewayOperationError extends Error {
  readonly code: string;
  readonly stage: string;
  constructor(code: string, stage: string, message: string) {
    super(message.slice(0, 256)); this.name = "GatewayOperationError"; this.code = code; this.stage = stage;
  }
}

export class GatewayAdapterError extends GatewayOperationError {
  constructor(
    readonly stage: "validation" | "probe" | "admin" | "reconcile",
    message: string,
    readonly code: "INVALID_ROUTE" | "ADMIN_UNAVAILABLE" | "ADMIN_REJECTED" | "PROBE_UNAVAILABLE" | "PROBE_TIMEOUT" = stage === "validation" ? "INVALID_ROUTE" : "ADMIN_UNAVAILABLE",
    readonly retryable = false
  ) {
    const bounded = message.replaceAll(/(?:https?|unix):\/\/[^\s]+/giu, "[private-endpoint]").replaceAll(/[\r\n\t]+/gu, " ").trim().slice(0, 256);
    super(code, stage, bounded || "gateway operation failed");
    this.name = "GatewayAdapterError";
  }
}


export function leaseFromRoute(input: PreviewGatewayRoute): PreviewGatewayLease {
  const lease = { leaseId: input.leaseId, hostIp: input.hostIp, hostPort: input.hostPort };
  return z.strictObject({ leaseId: uuidSchema, hostIp: z.literal("127.0.0.1"), hostPort: z.number().int().min(1).max(65535) }).parse(lease);
}
