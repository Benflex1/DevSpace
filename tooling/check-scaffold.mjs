import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const required = [
  'DEVSPACE_HANDOFF_V2.md',
  'AGENTS.md',
  'docs/architecture.md',
  'docs/security/threat-model.md',
  'docs/specs/project-options-v1.md',
  'docs/specs/database-v1.md',
  'docs/specs/agent-api-v1.md',
  'docs/specs/lifecycle-states.md',
  'schemas/project-options-v1.schema.json',
  'schemas/examples/project-options-v1.example.json'
];

for (const path of required) await access(path);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

const forbiddenConfigFiles = (await walk('.')).filter((path) => /(^|\/)\.devspace\.ya?ml$/.test(path));
if (forbiddenConfigFiles.length > 0) {
  throw new Error(`Repository YAML configuration is prohibited: ${forbiddenConfigFiles.join(', ')}`);
}

console.log('scaffold checks passed');
