import { NextResponse } from "next/server";
import { AgentResponseError, AgentUnavailableError, createAgentClient } from "../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../server/config.js";
import { DuplicateProjectSlugError, getProjectDatabase } from "../../../server/database.js";
import { OnboardingValidationError, onboardProject, parseOnboardingInput } from "../../../server/onboarding.js";
import { PROJECT_REGISTRATION_BODY_LIMIT_BYTES, RequestBodyMalformedError, RequestBodyTooLargeError, readBoundedJsonBody } from "../../../server/request-body.js";
import { normalizeUserFacingFailure } from "../../../server/user-facing-failure.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function POST(request: Request) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (!Number.isSafeInteger(contentLength) || contentLength > PROJECT_REGISTRATION_BODY_LIMIT_BYTES) return json({ message: "Request body is too large." }, 413);
    const input = parseOnboardingInput(await readBoundedJsonBody(request));
    const project = await onboardProject(input, actor.identity, {
      agent: createAgentClient(config.agentSocketPath),
      database: getProjectDatabase(config.databasePath)
    });
    return json({ project }, 201);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof DuplicateProjectSlugError) return json({ message: error.message }, 409);
    if (error instanceof OnboardingValidationError) return json({ message: error.message }, 422);
    if (error instanceof AgentUnavailableError || error instanceof AgentResponseError) return json(normalizeUserFacingFailure(error, {
      fallbackMessage: "Project registration failed safely.", event: "web.project_registration.failed",
      logMessage: "User-facing project registration failed"
    }), 503);
    if (error instanceof RequestBodyTooLargeError) return json({ message: error.message }, 413);
    if (error instanceof RequestBodyMalformedError) return json({ message: "Request body must be valid JSON." }, 400);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json(normalizeUserFacingFailure(error, {
      fallbackMessage: "Project registration failed safely.", event: "web.project_registration.failed",
      logMessage: "User-facing project registration failed"
    }), 500);
  }
}
