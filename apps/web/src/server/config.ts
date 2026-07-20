import { AGENT_SOCKET_PATH } from "@devspace/contracts";
import {
  createApprovedPreviewBase,
  createApprovedPreviewBaseRegistry,
  type ApprovedPreviewBaseRegistry
} from "@devspace/security";

export type AuthConfig =
  | { readonly mode: "development"; readonly actor: string }
  | { readonly mode: "cloudflare-access"; readonly issuer: string; readonly audience: string };

export interface WebRuntimeConfig {
  readonly databasePath: string;
  readonly agentSocketPath: string;
  readonly appOrigin: string;
  readonly auth: AuthConfig;
  readonly previewBaseRegistry: ApprovedPreviewBaseRegistry;
  readonly previewBases: readonly { readonly id: string; readonly domain: string }[];
  readonly previewGatewayProtocol: "http:" | "https:";
  readonly previewGatewayPort: number | null;
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function required(env: RuntimeEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`Missing required runtime configuration: ${name}`);
  return value;
}

function readPreviewBaseRegistry(env: RuntimeEnvironment): {
  readonly registry: ApprovedPreviewBaseRegistry;
  readonly publicBases: readonly { readonly id: string; readonly domain: string }[];
} {
  const raw = env.DEVSPACE_PREVIEW_BASES?.trim();
  if (raw === undefined || raw === "") {
    const empty = createApprovedPreviewBaseRegistry([]);
    if (!empty.ok) throw new Error("The default preview-base registry is invalid.");
    return { registry: empty.value, publicBases: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DEVSPACE_PREVIEW_BASES must be valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("DEVSPACE_PREVIEW_BASES must be a JSON array.");
  const bases = parsed.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null
      || typeof (candidate as { id?: unknown }).id !== "string"
      || typeof (candidate as { domain?: unknown }).domain !== "string") {
      throw new Error(`DEVSPACE_PREVIEW_BASES[${index}] must contain string id and domain fields.`);
    }
    const result = createApprovedPreviewBase(
      (candidate as { id: string }).id,
      (candidate as { domain: string }).domain
    );
    if (!result.ok) throw new Error(`DEVSPACE_PREVIEW_BASES[${index}] is invalid: ${result.error.code}.`);
    return result.value;
  });
  const domains = new Set<string>();
  for (const base of bases) {
    if (domains.has(base.domain)) throw new Error(`DEVSPACE_PREVIEW_BASES contains duplicate domain: ${base.domain}.`);
    domains.add(base.domain);
  }
  const registry = createApprovedPreviewBaseRegistry(bases);
  if (!registry.ok) throw new Error(`DEVSPACE_PREVIEW_BASES is invalid: ${registry.error.code}.`);
  return { registry: registry.value, publicBases: bases.map(({ id, domain }) => ({ id, domain })) };
}

export function readWebRuntimeConfig(env: RuntimeEnvironment = process.env): WebRuntimeConfig {
  const databasePath = required(env, "DEVSPACE_DATABASE_PATH");
  const appOriginValue = required(env, "DEVSPACE_APP_ORIGIN");
  const appOrigin = new URL(appOriginValue);
  if (!(["http:", "https:"] as const).includes(appOrigin.protocol as "http:" | "https:") || appOrigin.origin !== appOriginValue) {
    throw new Error("DEVSPACE_APP_ORIGIN must be an exact HTTP(S) origin without a path.");
  }
  const mode = required(env, "DEVSPACE_AUTH_MODE");
  const previewGatewayProtocolValue = env.DEVSPACE_PREVIEW_GATEWAY_PROTOCOL?.trim() || "https:";
  if (previewGatewayProtocolValue !== "http:" && previewGatewayProtocolValue !== "https:") {
    throw new Error("DEVSPACE_PREVIEW_GATEWAY_PROTOCOL must be http: or https:.");
  }
  const previewGatewayPortValue = env.DEVSPACE_PREVIEW_GATEWAY_PORT?.trim();
  const previewGatewayPort = previewGatewayPortValue === undefined || previewGatewayPortValue === "" ? null : Number(previewGatewayPortValue);
  if (previewGatewayPort !== null && (!Number.isSafeInteger(previewGatewayPort) || previewGatewayPort < 1 || previewGatewayPort > 65535)) {
    throw new Error("DEVSPACE_PREVIEW_GATEWAY_PORT must be a valid TCP port.");
  }
  let auth: AuthConfig;
  if (mode === "development") {
    if (env.NODE_ENV === "production") throw new Error("Development authentication is forbidden in production.");
    auth = { mode, actor: "local-dev@example.invalid" };
  } else if (mode === "cloudflare-access") {
    const issuerValue = required(env, "DEVSPACE_ACCESS_ISSUER");
    const issuer = new URL(issuerValue);
    if (issuer.protocol !== "https:" || issuer.origin !== issuerValue) {
      throw new Error("DEVSPACE_ACCESS_ISSUER must be an exact HTTPS origin.");
    }
    auth = { mode, issuer: issuer.origin, audience: required(env, "DEVSPACE_ACCESS_AUDIENCE") };
  } else {
    throw new Error("DEVSPACE_AUTH_MODE must be cloudflare-access or development.");
  }
  const previewBases = readPreviewBaseRegistry(env);
  return {
    databasePath,
    agentSocketPath: env.DEVSPACE_AGENT_SOCKET_PATH?.trim() || AGENT_SOCKET_PATH,
    appOrigin: appOrigin.origin,
    auth,
    previewBaseRegistry: previewBases.registry, previewBases: previewBases.publicBases,
    previewGatewayProtocol: previewGatewayProtocolValue, previewGatewayPort
  };
}
