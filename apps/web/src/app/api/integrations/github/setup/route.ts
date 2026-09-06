import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { githubDecimalIdSchema } from "@devspace/contracts";
import { authenticateHeaders, AuthenticationError } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { createAgentClient } from "../../../../../server/agent-client.js";
import { getProjectDatabase } from "../../../../../server/database.js";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const redirect = (origin: string, status: string) => NextResponse.redirect(new URL(`/?github=${status}`, origin), { status: 303 });
  try {
    const config = readWebRuntimeConfig(); const actor = await authenticateHeaders(request.headers, config.auth);
    const url = new URL(request.url); const allowed = new Set(["state", "installation_id", "setup_action"]);
    if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) return redirect(config.appOrigin, "failed");
    const state = url.searchParams.get("state"); const installationId = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action");
    if (state === null || !/^[A-Za-z0-9_-]{43}$/u.test(state) || installationId === null
      || !githubDecimalIdSchema.safeParse(installationId).success || (setupAction !== null && setupAction !== "install" && setupAction !== "update")) {
      return redirect(config.appOrigin, "failed");
    }
    const database = getProjectDatabase(config.databasePath);
    const attempt = database.claimGithubConnectionAttempt({ actor: actor.identity,
      stateHash: createHash("sha256").update(state, "utf8").digest("hex"), installationId });
    const verified = await createAgentClient(config.agentSocketPath).verifyGithubInstallation(attempt.connectionId, installationId);
    database.connectGithubInstallation({ actor: actor.identity, ...verified });
    return redirect(config.appOrigin, verified.cleanupDegraded ? "degraded" : "connected");
  } catch (error) {
    if (error instanceof AuthenticationError) return NextResponse.json({ message: "Authentication is required." }, { status: 403 });
    const origin = (() => { try { return readWebRuntimeConfig().appOrigin; } catch { return new URL(request.url).origin; } })();
    return redirect(origin, "failed");
  }
}
