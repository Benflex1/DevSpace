import { afterEach, expect, test, vi } from "vitest";
import { POST } from "./route.js";

afterEach(() => vi.unstubAllEnvs());

function configure(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("DEVSPACE_DATABASE_PATH", "/tmp/devspace-preview-route-test.sqlite");
  vi.stubEnv("DEVSPACE_AGENT_SOCKET_PATH", "/tmp/devspace-preview-route-test.sock");
}

const previewId = "0190a000-0000-7000-8000-000000000013";

test("requires CSRF for preview mutations", async () => {
  configure();
  const response = await POST(new Request("http://localhost:3000/api/projects/project/previews", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "reload", previewId })
  }), { params: Promise.resolve({ projectId: "0190a000-0000-7000-8000-000000000010" }) });
  expect(response.status).toBe(403);
});
test("rejects browser-supplied hostname and other activation fields", async () => {
  configure();
  const response = await POST(new Request("http://localhost:3000/api/projects/project/previews", {
    method: "POST", headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ action: "reload", previewId, hostname: "attacker.example" })
  }), { params: Promise.resolve({ projectId: "0190a000-0000-7000-8000-000000000010" }) });
  expect(response.status).toBe(422);
});
