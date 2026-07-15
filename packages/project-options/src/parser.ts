import * as z from "zod";
import { projectOptionsV1Schema, type ProjectOptionsV1 } from "./schema.js";

export function parseProjectOptionsV1(input: unknown): ProjectOptionsV1 {
  return projectOptionsV1Schema.parse(input);
}

export function safeParseProjectOptionsV1(
  input: unknown
): z.ZodSafeParseResult<ProjectOptionsV1> {
  return projectOptionsV1Schema.safeParse(input);
}
