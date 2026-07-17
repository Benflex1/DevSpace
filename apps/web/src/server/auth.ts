import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthConfig } from "./config.js";

const accessJwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export const ACCESS_IAT_CLOCK_SKEW_SECONDS = 60;

export interface AuthenticatedActor { readonly identity: string }
export class AuthenticationError extends Error {
  constructor() { super("Authentication is required."); this.name = "AuthenticationError"; }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159));
  });
}

export async function authenticateHeaders(headers: Headers, config: AuthConfig): Promise<AuthenticatedActor> {
  if (config.mode === "development") return { identity: config.actor };
  const token = headers.get("cf-access-jwt-assertion");
  if (token === null || token === "") throw new AuthenticationError();
  try {
    let jwks = accessJwks.get(config.issuer);
    if (jwks === undefined) {
      jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", `${config.issuer}/`));
      accessJwks.set(config.issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat"]
    });
    const currentEpochSeconds = Math.floor(Date.now() / 1000);
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)
      || payload.iat > currentEpochSeconds + ACCESS_IAT_CLOCK_SKEW_SECONDS) {
      throw new AuthenticationError();
    }
    const identity = typeof payload.email === "string" && payload.email !== ""
      ? payload.email
      : typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
    if (identity === null || identity.length > 512 || containsControlCharacter(identity)) {
      throw new AuthenticationError();
    }
    return { identity };
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError();
  }
}

export function assertCsrf(request: Request, appOrigin: string): void {
  if (request.headers.get("origin") !== appOrigin || request.headers.get("x-devspace-csrf") !== "1") {
    throw new Error("CSRF_REJECTED");
  }
}
