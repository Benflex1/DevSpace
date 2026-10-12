import { NextResponse } from "next/server";
import { revisionIdentitySchema } from "@devspace/contracts";
import { z } from "zod";
import { AuthenticationError, assertCsrf, authenticateHeaders } from "../../../../../server/auth.js";
import { readWebRuntimeConfig } from "../../../../../server/config.js";
import { ProjectSetupConflictError, getProjectDatabase } from "../../../../../server/database.js";
import { readBoundedJsonBody, RequestBodyMalformedError, RequestBodyTooLargeError } from "../../../../../server/request-body.js";
import { ProjectOptionsValidationError, readProjectOptions, saveProjectOptionsDraft } from "../../../../../server/project-options-adoption.js";

export const dynamic = "force-dynamic";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
const saveSchema = z.strictObject({ expectedRevision: revisionIdentitySchema, options: z.unknown() });

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    await authenticateHeaders(request.headers, config.auth);
    const { projectId } = await context.params;
    return json(readProjectOptions(projectId, {
      database: getProjectDatabase(config.databasePath), previewBaseRegistry: config.previewBaseRegistry
    }));
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    return json({ message: "Project Options could not be loaded safely." }, 500);
  }
}

export async function PUT(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const config = readWebRuntimeConfig();
    const actor = await authenticateHeaders(request.headers, config.auth);
    assertCsrf(request, config.appOrigin);
    const body = saveSchema.safeParse(await readBoundedJsonBody(request, 2_200_000));
    if (!body.success) return json({ message: "Provide the expected active revision and valid Project Options.", issues: body.error.issues }, 422);
    const { projectId } = await context.params;
    const draft = saveProjectOptionsDraft({ projectId, actor: actor.identity,
      expectedRevision: body.data.expectedRevision, options: body.data.options }, {
      database: getProjectDatabase(config.databasePath), previewBaseRegistry: config.previewBaseRegistry
    });
    return json({ draft }, 201);
  } catch (error) {
    if (error instanceof AuthenticationError) return json({ message: "Authentication is required." }, 403);
    if (error instanceof ProjectSetupConflictError) return json({ message: error.message }, 409);
    if (error instanceof ProjectOptionsValidationError) return json({ message: error.message, field: error.field }, 422);
    if (error instanceof RequestBodyTooLargeError) return json({ message: error.message }, 413);
    if (error instanceof RequestBodyMalformedError) return json({ message: "Request body must be valid JSON." }, 400);
    if (error instanceof Error && error.message === "CSRF_REJECTED") return json({ message: "Request origin could not be verified." }, 403);
    return json({ message: "Project Options could not be saved safely." }, 500);
  }
}
