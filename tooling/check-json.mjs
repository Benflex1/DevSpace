import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

for (const file of await walk('schemas')) {
  if (extname(file) !== '.json') continue;
  JSON.parse(await readFile(file, 'utf8'));
  console.log(`valid JSON: ${file}`);
}
