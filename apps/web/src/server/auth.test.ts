import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from "jose";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { ACCESS_IAT_CLOCK_SKEW_SECONDS, AuthenticationError, assertCsrf, authenticateHeaders } from "./auth.js";
import { readWebRuntimeConfig } from "./config.js";

const base = { DEVSPACE_DATABASE_PATH: "/tmp/test.sqlite", DEVSPACE_APP_ORIGIN: "http://localhost:3000" };
let jwksServer: http.Server;
let issuer: string;
let privateKey: CryptoKey;
let wrongPrivateKey: CryptoKey;
const audience = "devspace-test-audience";

beforeAll(async () => {
  const signing = await generateKeyPair("RS256", { extractable: true });
  const wrong = await generateKeyPair("RS256", { extractable: true });
  privateKey = signing.privateKey;
  wrongPrivateKey = wrong.privateKey;
  const jwk = await exportJWK(signing.publicKey);
  Object.assign(jwk, { kid: "test-key", alg: "RS256", use: "sig" });
  jwksServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve, reject) => {
    jwksServer.once("error", reject);
    jwksServer.listen(0, "127.0.0.1", resolve);
  });
  const address = jwksServer.address();
  if (address === null || typeof address === "string") throw new Error("JWKS test server did not bind TCP.");
  issuer = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => { await new Promise<void>((resolve, reject) => jwksServer.close((error) => error === undefined ? resolve() : reject(error))); });

async function signedToken(input: { iat?: number; exp?: number; iss?: string; aud?: string; key?: CryptoKey; includeIat?: boolean } = {}): Promise<string> {
  const current = Math.floor(Date.now() / 1000);
  const token = new SignJWT({ email: "owner@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(input.iss ?? issuer)
    .setAudience(input.aud ?? audience)
    .setExpirationTime(input.exp ?? current + 300);
  if (input.includeIat !== false) token.setIssuedAt(input.iat ?? current);
  return await token.sign(input.key ?? privateKey);
}

test("fails closed when authentication configuration is absent or development auth is used in production", () => {
  expect(() => readWebRuntimeConfig({ ...base })).toThrow(/DEVSPACE_AUTH_MODE/u);
  expect(() => readWebRuntimeConfig({ ...base, DEVSPACE_AUTH_MODE: "cloudflare-access" })).toThrow(/DEVSPACE_ACCESS_ISSUER/u);
  expect(() => readWebRuntimeConfig({ ...base, DEVSPACE_AUTH_MODE: "development", NODE_ENV: "production" })).toThrow(/forbidden/u);
});

test("development auth is explicit and deterministic while Cloudflare mode requires a validated JWT", async () => {
  const config = readWebRuntimeConfig({ ...base, DEVSPACE_AUTH_MODE: "development", NODE_ENV: "test" });
  await expect(authenticateHeaders(new Headers(), config.auth)).resolves.toEqual({ identity: "local-dev@example.invalid" });
  await expect(authenticateHeaders(new Headers(), {
    mode: "cloudflare-access", issuer: "https://team.cloudflareaccess.com", audience: "audience"
  })).rejects.toBeInstanceOf(AuthenticationError);
});

test("performs real RS256/JWKS verification and rejects invalid signed Access tokens", async () => {
  const config = { mode: "cloudflare-access" as const, issuer, audience };
  const authenticate = async (token: string) => await authenticateHeaders(new Headers({ "cf-access-jwt-assertion": token }), config);
  await expect(authenticate(await signedToken())).resolves.toEqual({ identity: "owner@example.com" });
  await expect(authenticate(await signedToken({ exp: Math.floor(Date.now() / 1000) - 1 }))).rejects.toBeInstanceOf(AuthenticationError);
  await expect(authenticate(await signedToken({ aud: "wrong-audience" }))).rejects.toBeInstanceOf(AuthenticationError);
  await expect(authenticate(await signedToken({ iss: `${issuer}/wrong` }))).rejects.toBeInstanceOf(AuthenticationError);
  await expect(authenticate(await signedToken({ key: wrongPrivateKey }))).rejects.toBeInstanceOf(AuthenticationError);
  await expect(authenticateHeaders(new Headers({ "cf-access-authenticated-user-email": "forged@example.com" }), config)).rejects.toBeInstanceOf(AuthenticationError);
});

test("fails closed for missing, non-numeric, malformed, and non-RS256 JWTs", async () => {
  const config = { mode: "cloudflare-access" as const, issuer, audience };
  const authenticate = async (token: string) => await authenticateHeaders(new Headers({ "cf-access-jwt-assertion": token }), config);
  await expect(authenticate(await signedToken({ includeIat: false }))).rejects.toBeInstanceOf(AuthenticationError);
  const invalidIat = await new SignJWT({ email: "owner@example.com", iat: "not-a-number" } as unknown as JWTPayload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(issuer).setAudience(audience)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300).sign(privateKey);
  await expect(authenticate(invalidIat)).rejects.toBeInstanceOf(AuthenticationError);
  await expect(authenticate("not.a.jwt")).rejects.toBeInstanceOf(AuthenticationError);
  const algorithmInvalid = await new SignJWT({ email: "owner@example.com", iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: "HS256" }).setIssuer(issuer).setAudience(audience)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300).sign(new TextEncoder().encode("algorithm-test-key"));
  await expect(authenticate(algorithmInvalid)).rejects.toBeInstanceOf(AuthenticationError);
});

test("accepts iat within the explicit skew and rejects materially future-issued signed JWTs", async () => {
  const config = { mode: "cloudflare-access" as const, issuer, audience };
  const current = Math.floor(Date.now() / 1000);
  const authenticate = async (token: string) => await authenticateHeaders(new Headers({ "cf-access-jwt-assertion": token }), config);
  await expect(authenticate(await signedToken({ iat: current + ACCESS_IAT_CLOCK_SKEW_SECONDS }))).resolves.toEqual({ identity: "owner@example.com" });
  await expect(authenticate(await signedToken({ iat: current + 3_600 }))).rejects.toBeInstanceOf(AuthenticationError);
});

test("rejects cross-origin or unmarked browser mutations", () => {
  const valid = new Request("http://localhost:3000/api/projects", { method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1" } });
  expect(() => assertCsrf(valid, "http://localhost:3000")).not.toThrow();
  expect(() => assertCsrf(new Request(valid, { headers: { origin: "https://evil.example", "x-devspace-csrf": "1" } }), "http://localhost:3000")).toThrow("CSRF_REJECTED");
  vi.restoreAllMocks();
});
