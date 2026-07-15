import * as z from "zod";
import { projectOptionsV1Schema } from "./schema.js";

export {
  projectOptionsV1Schema,
  type ProjectOptionsV1,
  type ProjectOptionsV1Input
} from "./schema.js";

export { parseProjectOptionsV1, safeParseProjectOptionsV1 } from "./parser.js";

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

export {
  canonicalizeProjectOptionsV1,
  canonicalizeProjectOptionsV1Bytes,
  hashProjectOptionsV1,
  type ProjectOptionsRevisionHash
} from "./revision.js";
