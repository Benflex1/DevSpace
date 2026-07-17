import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { openProjectDatabase } from "../../../server/database.js";
import { PROJECT_REGISTRATION_BODY_LIMIT_BYTES } from "../../../server/request-body.js";
import { POST } from "./route.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function configure(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "devspace-route-"));
  directories.push(directory);
  const databasePath = path.join(directory, "devspace.sqlite");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DEVSPACE_AUTH_MODE", "development");
  vi.stubEnv("DEVSPACE_APP_ORIGIN", "http://localhost:3000");
  vi.stubEnv("DEVSPACE_DATABASE_PATH", databasePath);
  vi.stubEnv("DEVSPACE_AGENT_SOCKET_PATH", path.join(directory, "agent.sock"));
  return databasePath;
}

test("API safely rejects a secret-bearing URL without echoing or persisting it", async () => {
  const databasePath = await configure();
  const secret = "review-secret";
  const response = await POST(new Request("http://localhost:3000/api/projects", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ repositoryUrl: `https://example.com/repo.git?access_token=${secret}`, name: "Repo", slug: "repo" })
  }));
  const raw = await response.text();
  expect(response.status).toBe(422);
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain("access_token");
  const database = openProjectDatabase(databasePath);
  expect(database.listProjects()).toEqual([]);
  database.close();
});

test("API reports SSH as an unsupported onboarding capability before Agent access", async () => {
  await configure();
  const response = await POST(new Request("http://localhost:3000/api/projects", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
    body: JSON.stringify({ repositoryUrl: "ssh://git@example.com/repo.git", name: "Repo", slug: "repo" })
  }));
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ message: "Project onboarding currently supports HTTPS Git repository URLs only." });
});

test("route stops a chunked body at the application bound and returns 413", async () => {
  await configure();
  let pulls = 0;
  let cancelled = false;
  const chunks = [new Uint8Array(PROJECT_REGISTRATION_BODY_LIMIT_BYTES), Uint8Array.of(1), new Uint8Array(10_000)];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[pulls++];
      if (chunk === undefined) controller.close();
      else controller.enqueue(chunk);
    },
    cancel() { cancelled = true; }
  }, { highWaterMark: 0 });
  const response = await POST(new Request("http://localhost:3000/api/projects", {
    method: "POST",
    headers: { origin: "http://localhost:3000", "x-devspace-csrf": "1", "content-type": "application/json" },
    body: stream,
    duplex: "half"
  } as RequestInit & { duplex: "half" }));
  expect(response.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(pulls).toBe(2);
});
