import { NextResponse } from "next/server";
import { revisionIdentitySchema, uuidV7Schema } from "@devspace/contracts";
import { z } from "zod";
import { createAgentClient } from "../../../../../../server/agent-client.js";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../../server/database.js";
import { RequestBodyMalformedError, RequestBodyTooLargeError, readBoundedJsonBody } from "../../../../../../server/request-body.js";
import { applyProjectOptions, ProjectOptionsAdoptionError, ProjectOptionsValidationError } from "../../../../../../server/project-options-adoption.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const applySchema = z.strictObject({ expectedRevision: revisionIdentitySchema, candidateRevisionId: uuidV7Schema });

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    const body = applySchema.safeParse(await readBoundedJsonBody(request));
    if (!body.success) return json({ message: "Provide the expected active revision and saved candidate revision." , issues: body.error.issues }, 422);
    const { projectId } = await context.params;
    const result = await applyProjectOptions({ projectId, actor: actor.identity,
      expectedRevision: body.data.expectedRevision, candidateRevisionId: body.data.candidateRevisionId }, {
      database: getProjectDatabase(config.databasePath), agent: createAgentClient(config.agentSocketPath),
      previewBaseRegistry: config.previewBaseRegistry
    });
    return json(result, result.state === "pending" ? 202 : 200);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof ProjectOptionsAdoptionError) return json({ message: error.message, code: error.code, retryable: error.retryable }, error.status);
    if (error instanceof ProjectOptionsValidationError) return json({ message: error.message, field: error.field }, 422);
    if (error instanceof RequestBodyTooLargeError) return json({ message: error.message }, 413);
    if (error instanceof RequestBodyMalformedError) return json({ message: "Request body must be valid JSON." }, 400);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json({ message: "Project Options could not be applied safely." }, 500);
  }
}
