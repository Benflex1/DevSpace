import { AGENT_SOCKET_PATH } from "@devspace/contracts";

export type AuthConfig =
  | { readonly mode: "development"; readonly actor: string }
  | { readonly mode: "cloudflare-access"; readonly issuer: string; readonly audience: string };

export interface WebRuntimeConfig {
  readonly databasePath: string;
  readonly agentSocketPath: string;
  readonly appOrigin: string;
  readonly auth: AuthConfig;
}

type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

function required(env: RuntimeEnvironment, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`Missing required runtime configuration: ${name}`);
  return value;
}

export function readWebRuntimeConfig(env: RuntimeEnvironment = process.env): WebRuntimeConfig {
  const databasePath = required(env, "DEVSPACE_DATABASE_PATH");
  const appOriginValue = required(env, "DEVSPACE_APP_ORIGIN");
  const appOrigin = new URL(appOriginValue);
  if (!(["http:", "https:"] as const).includes(appOrigin.protocol as "http:" | "https:") || appOrigin.origin !== appOriginValue) {
    throw new Error("DEVSPACE_APP_ORIGIN must be an exact HTTP(S) origin without a path.");
  }
  const mode = required(env, "DEVSPACE_AUTH_MODE");
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
  return {
    databasePath,
    agentSocketPath: env.DEVSPACE_AGENT_SOCKET_PATH?.trim() || AGENT_SOCKET_PATH,
    appOrigin: appOrigin.origin,
    auth
  };
}
