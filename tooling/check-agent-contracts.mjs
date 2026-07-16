import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateAgentApiV1JsonSchema } from "../packages/contracts/dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const artifact = path.join(root, "schemas/agent-api-v1.schema.json");
const content = `${JSON.stringify(generateAgentApiV1JsonSchema(), null, 2)}\n`;

if (process.argv.includes("--write")) {
  await writeFile(artifact, content, "utf8");
  console.log("Wrote schemas/agent-api-v1.schema.json");
} else {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "devspace-contracts-"));
  const generated = path.join(temporaryDirectory, "agent-api-v1.schema.json");
  try {
    await writeFile(generated, content, "utf8");
    const committedContent = await readFile(artifact, "utf8");
    const generatedContent = await readFile(generated, "utf8");
    if (committedContent !== generatedContent) {
      console.error("Agent API v1 JSON Schema drift detected. Regenerate the committed artifact.");
      process.exitCode = 1;
    } else {
      console.log("Agent API v1 contract artifact is current and byte-identical.");
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
