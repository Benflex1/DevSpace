import * as z from "zod";
import {
  projectOptionsV1Schema,
  type ProjectOptionsV1
} from "./schema.js";

export {
  projectOptionsV1Schema,
  type ProjectOptionsV1,
  type ProjectOptionsV1Input
} from "./schema.js";

export function parseProjectOptionsV1(input: unknown): ProjectOptionsV1 {
  return projectOptionsV1Schema.parse(input);
}

export function safeParseProjectOptionsV1(
  input: unknown
): z.ZodSafeParseResult<ProjectOptionsV1> {
  return projectOptionsV1Schema.safeParse(input);
}

export type ProjectOptionsV1JsonSchema = Record<string, unknown>;

export function generateProjectOptionsV1JsonSchema(): ProjectOptionsV1JsonSchema {
  const generated = z.toJSONSchema(projectOptionsV1Schema, {
    target: "draft-2020-12",
    io: "input"
  }) as ProjectOptionsV1JsonSchema;
  return {
    ...generated,
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://devspace.local/schemas/project-options-v1.schema.json",
    title: "DevSpace Project Options v1"
  };
}

export const projectOptionsV1JsonSchema = generateProjectOptionsV1JsonSchema();
