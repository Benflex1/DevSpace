import {
  customHarnessDefinitionSchema,
  type CustomHarnessDefinition
} from "@devspace/contracts";
import type { ProjectDatabase } from "./database.js";

export function listCustomHarnessDefinitions(database: ProjectDatabase): CustomHarnessDefinition[] {
  return database.listHarnessDefinitions().map((row) => customHarnessDefinitionSchema.parse({
    id: row.id,
    displayName: row.displayName,
    origin: "custom",
    launch: JSON.parse(row.launchJson) as CustomHarnessDefinition["launch"],
    resume: row.resumeJson === null ? null : JSON.parse(row.resumeJson) as unknown,
    environment: JSON.parse(row.environmentJson) as CustomHarnessDefinition["environment"],
    privateState: { kind: "none" }
  }));
}

export function saveCustomHarnessDefinition(database: ProjectDatabase, input: unknown): CustomHarnessDefinition {
  const parsed = customHarnessDefinitionSchema.parse(input);
  database.saveHarnessDefinition({
    id: parsed.id,
    displayName: parsed.displayName,
    launchJson: JSON.stringify(parsed.launch),
    resumeJson: parsed.resume === null ? null : JSON.stringify(parsed.resume),
    environmentJson: JSON.stringify(parsed.environment)
  });
  return parsed;
}
