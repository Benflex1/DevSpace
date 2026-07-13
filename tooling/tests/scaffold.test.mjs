import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('Project Options example uses schema version 1', async () => {
  const example = JSON.parse(await readFile('schemas/examples/project-options-v1.example.json', 'utf8'));
  assert.equal(example.schemaVersion, 1);
  assert.equal(example.environment.passwordlessSudo, true);
});

test('Project Options schema rejects unknown top-level fields by design', async () => {
  const schema = JSON.parse(await readFile('schemas/project-options-v1.schema.json', 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, 1);
});
